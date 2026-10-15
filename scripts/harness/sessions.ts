/**
 * The session phase.
 *
 * Two real sessions are created in two different directories and driven
 * through the instance's own HTTP API. A location-scoped request comes first
 * because that is what activates a location and loads its project plugins; the
 * transcripts are read back afterwards, and the answers are checked against the
 * tokens the prompts asked for.
 */

import { drivenModel, modelLabel, type HarnessOptions, type ModelRef } from "./args.ts"
import type { HarnessClient, SessionInfo, SessionMessage, SessionTextPart, SessionToolPart } from "./client.ts"
import { sleep } from "./instance.ts"
import type { ScratchLayout } from "./paths.ts"
import { explain, type Expectation, type MessageSummary, type SessionSummary } from "./report.ts"

/** What each session is asked to answer with, and what the transcript must show. */
const TOKENS: Record<SessionSummary["label"], string> = {
  A: "HARNESS_SESSION_A_OK",
  B: "HARNESS_SESSION_B_OK",
}

const TURN_POLL_MS = 1_000
/**
 * How often one session's turn may be asked for before the harness gives up.
 *
 * The host's hosted provider refuses a share of the model calls it is asked for
 * from a fresh instance, and a session whose turn was refused cannot be asked
 * again: the next call from it is answered out of the failure, without reaching
 * the model. Each further attempt therefore gets a fresh session in the same
 * directory, and every attempt is reported.
 */
const MAX_DRIVE_ATTEMPTS = 3

/** How one driven turn ended, and what the transcript says about a failure. */
interface TurnOutcome {
  outcome: string
  elapsedMs: number
  /** The provider's own words about the failure, when the transcript has them. */
  reason?: string
}

/** A location-scoped request is what activates a location and loads its plugins. */
export async function activateLocations(
  client: HarnessClient,
  layout: ScratchLayout,
  expectations: Expectation[],
): Promise<void> {
  const expected = "serving each project activates its location and loads its project plugins"
  const locations = [
    { label: "A", directory: layout.projectA },
    { label: "B", directory: layout.projectB },
  ]
  try {
    const observed: string[] = []
    for (const location of locations) {
      const models = await client.models(location.directory)
      observed.push(`${location.label}: ${location.directory} (${models.length} models offered)`)
    }
    expectations.push({ name: "locations-activate", met: true, expected, observed: observed.join(", ") })
  } catch (error) {
    expectations.push({ name: "locations-activate", met: false, expected, observed: explain(error) })
    throw error
  }
}

export async function createSessions(
  client: HarnessClient,
  layout: ScratchLayout,
  options: HarnessOptions,
  expectations: Expectation[],
): Promise<SessionInfo[]> {
  const expected = "two sessions exist in two different directories"
  const model = drivenModel(options)
  try {
    const created = await Promise.all([
      client.createSession({
        directory: layout.projectA,
        title: "harness-a",
        ...(model === undefined ? {} : { model }),
      }),
      client.createSession({
        directory: layout.projectB,
        title: "harness-b",
        ...(model === undefined ? {} : { model }),
      }),
    ])
    const fetched = await Promise.all([client.getSession(created[0]!.id), client.getSession(created[1]!.id)])
    const met =
      fetched[0]!.location.directory === layout.projectA &&
      fetched[1]!.location.directory === layout.projectB &&
      fetched[0]!.id !== fetched[1]!.id
    expectations.push({
      name: "sessions-created",
      met,
      expected,
      observed: `A ${fetched[0]!.id} in ${fetched[0]!.location.directory}, B ${fetched[1]!.id} in ${fetched[1]!.location.directory}`,
    })
    if (!met) throw new Error("the created sessions did not land in the two project directories")
    return fetched
  } catch (error) {
    if (!expectations.some((expectation) => expectation.name === "sessions-created")) {
      expectations.push({ name: "sessions-created", met: false, expected, observed: explain(error) })
    }
    throw error
  }
}

export async function driveTurns(
  client: HarnessClient,
  options: HarnessOptions,
  sessions: readonly SessionSummary[],
  expectations: Expectation[],
  disclosures: string[],
): Promise<SessionSummary[]> {
  const expected = "a driven turn reaches a terminal outcome in each session"
  try {
    if (options.model !== undefined) await requireModel(client, options.model, sessions[0]!.directory, expectations)
    // One session at a time: the host's hosted provider refuses turns that are
    // asked for concurrently while it is still registering itself.
    const driven: DrivenTurn[] = []
    for (const session of sessions) driven.push(await driveOne(client, options, session, disclosures))
    const met = driven.every((turn) => turn.attempts.at(-1)!.outcome === "succeeded")
    expectations.push({
      name: "turns-complete",
      met,
      expected,
      observed: driven.map((turn) => describeDrive(turn)).join("; "),
    })
    if (!met) throw new Error("at least one driven turn did not succeed")
    return driven.map((turn) => turn.session)
  } catch (error) {
    if (!expectations.some((expectation) => expectation.name === "turns-complete")) {
      expectations.push({ name: "turns-complete", met: false, expected, observed: explain(error) })
    }
    throw error
  }
}

interface DrivenTurn {
  label: SessionSummary["label"]
  /** The session the report names: the one that answered, or the last one asked. */
  session: SessionSummary
  attempts: TurnOutcome[]
}

/**
 * One session's driven turn, asked for until it is answered or the attempts run
 * out.
 *
 * The host refuses part of the model calls it is asked for from a fresh
 * instance, and a session whose turn was refused that way keeps failing — the
 * next call from it is answered from the failure, without reaching the model.
 * A fresh session in the same directory is served, so each further attempt gets
 * one. Every attempt is reported: a run that needed a second session must not
 * look like a run that passed first time.
 */
async function driveOne(
  client: HarnessClient,
  options: HarnessOptions,
  session: SessionSummary,
  disclosures: string[],
): Promise<DrivenTurn> {
  const attempts: TurnOutcome[] = []
  const refused: string[] = []
  let current = session

  for (let attempt = 1; attempt <= MAX_DRIVE_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now()
    await client.prompt(
      current.id,
      `Reply with exactly the token ${TOKENS[session.label]} and nothing else. Do not use any tools.`,
    )
    const outcome = await waitForOutcome(client, options, current.id, `${session.label} attempt ${attempt}`)
    const reason = outcome === "succeeded" ? undefined : await failureReason(client, current.id)
    attempts.push({ outcome, elapsedMs: Date.now() - startedAt, ...(reason === undefined ? {} : { reason }) })
    if (outcome === "succeeded" || attempt === MAX_DRIVE_ATTEMPTS) break

    refused.push(current.id)
    const replacement = await client.createSession({
      directory: session.directory,
      title: session.title,
      ...(options.model === undefined ? {} : { model: options.model }),
    })
    current = summarizeSession(session.label, await client.getSession(replacement.id))
  }

  if (refused.length > 0) {
    const answered = attempts.at(-1)!.outcome === "succeeded"
    if (!answered) refused.push(current.id)
    disclosures.push(
      `session ${session.label} was created more than once after a failed turn: ${refused.join(
        ", ",
      )} did not succeed${answered ? `; the session named in the report is ${current.id}` : ""}`,
    )
  }
  return { label: session.label, session: current, attempts }
}

function describeDrive(turn: DrivenTurn): string {
  const last = turn.attempts.at(-1)!
  const earlier =
    turn.attempts.length === 1
      ? ""
      : ` (attempt ${turn.attempts.length} of ${MAX_DRIVE_ATTEMPTS}; earlier: ${turn.attempts
          .slice(0, -1)
          .map((attempt) => `${attempt.outcome}${reasonSuffix(attempt)}`)
          .join("; ")})`
  return `${turn.label}: ${last.outcome} in ${last.elapsedMs} ms${reasonSuffix(last)}${earlier}`
}

/** The requested model must be one the instance offers, whoever asked for it. */
export async function requireModel(
  client: HarnessClient,
  requested: ModelRef,
  directory: string,
  expectations: Expectation[],
): Promise<void> {
  const expected = `the requested model ${modelLabel(requested)} is offered by the instance`
  const models = await client.models(directory)
  const found = models.some((model) => model.providerID === requested.providerID && model.id === requested.id)
  expectations.push({
    name: "model-available",
    met: found,
    expected,
    observed: found
      ? `${modelLabel(requested)} is offered`
      : `${modelLabel(requested)} is not offered; offered: ${models.slice(0, 8).map(modelLabel).join(", ")}`,
  })
  if (!found) throw new Error(`the requested model ${modelLabel(requested)} is not offered by the instance`)
}

/** A session's terminal outcome, or a failure naming the subject and the state it stalled in. */
export async function waitForOutcome(
  client: HarnessClient,
  options: HarnessOptions,
  sessionID: string,
  subject: string,
): Promise<string> {
  const startedAt = Date.now()
  for (;;) {
    const info = await client.getSession(sessionID)
    if (info.outcome !== undefined) return info.outcome
    if (Date.now() - startedAt > options.turnTimeoutMs) {
      throw new Error(
        `${subject} reached no outcome within ${options.turnTimeoutMs} ms (last state: ${describeSession(info)})`,
      )
    }
    await sleep(TURN_POLL_MS)
  }
}

/**
 * Why a turn that did not succeed failed, as far as its transcript says. This
 * only runs on the failure path, so a broken transcript cannot mask the real
 * failure by throwing a second time.
 */
async function failureReason(client: HarnessClient, sessionID: string): Promise<string | undefined> {
  try {
    const messages = await client.context(sessionID)
    return messages
      .map((message) => message.error?.message ?? message.error?.type)
      .filter((text): text is string => text !== undefined)
      .at(-1)
  } catch {
    return undefined
  }
}

function reasonSuffix(outcome: TurnOutcome): string {
  return outcome.reason === undefined ? "" : ` — ${outcome.reason}`
}

export async function readTranscripts(
  client: HarnessClient,
  sessions: readonly SessionSummary[],
  options: HarnessOptions,
  expectations: Expectation[],
): Promise<SessionSummary[]> {
  const expected = "each session's conversation can be read back through the instance API"
  try {
    const read = await Promise.all(
      sessions.map(async (session) => {
        const [messages, info] = await Promise.all([client.context(session.id), client.getSession(session.id)])
        return {
          ...session,
          messages: messages.map(summarizeMessage),
          ...(info.outcome === undefined ? {} : { outcome: info.outcome }),
          ...(info.model == null ? {} : { model: modelLabel(info.model) }),
        } satisfies SessionSummary
      }),
    )
    expectations.push({
      name: "conversations-readable",
      met: true,
      expected:
        options.driveModel || options.stub ? `${expected}, including the driven turn` : expected,
      observed: read.map((session) => `${session.label}: ${session.messages.length} messages`).join(", "),
    })
    return read
  } catch (error) {
    if (!expectations.some((expectation) => expectation.name === "conversations-readable")) {
      expectations.push({ name: "conversations-readable", met: false, expected, observed: explain(error) })
    }
    throw error
  }
}

/** Each driven session must have answered with its own token. */
export function checkAnswers(sessions: readonly SessionSummary[], expectations: Expectation[]): void {
  const expected = "each driven session answered with its own token"
  const observed: string[] = []
  let met = true
  for (const session of sessions) {
    const token = TOKENS[session.label]
    const text = session.messages
      .filter((message) => message.type === "assistant")
      .map((message) => message.text ?? "")
      .join(" ")
    const found = text.includes(token)
    if (!found) met = false
    observed.push(
      `${session.label}: ${found ? `found ${token}` : `missing ${token} (assistant said ${JSON.stringify(text.slice(0, 80))})`}`,
    )
  }
  expectations.push({ name: "turn-answers", met, expected, observed: observed.join("; ") })
}

export function summarizeSession(label: SessionSummary["label"], info: SessionInfo): SessionSummary {
  return {
    label,
    id: info.id,
    directory: info.location.directory,
    title: info.title ?? "",
    messages: [],
    ...(info.model == null ? {} : { model: modelLabel(info.model) }),
    ...(info.outcome === undefined ? {} : { outcome: info.outcome }),
  }
}

function summarizeMessage(message: SessionMessage): MessageSummary {
  const text = messageText(message)
  return {
    type: message.type,
    ...(text.length === 0 ? {} : { text }),
    ...(message.finish === undefined ? {} : { finish: message.finish }),
    ...(message.error === undefined ? {} : { error: message.error.type ?? message.error.message ?? "unknown" }),
  }
}

/**
 * A message's text, wherever the host keeps it: a plain `text` field on user
 * and assistant messages, or text parts on a message that mixes tool calls in.
 * Tool parts are not text, so they contribute nothing here.
 */
export function messageText(message: SessionMessage): string {
  if (message.text !== undefined) return message.text
  let text = ""
  for (const part of message.content ?? []) {
    if (!isToolPart(part)) text += part.text ?? ""
  }
  return text
}

function isToolPart(part: SessionTextPart | SessionToolPart): part is SessionToolPart {
  return part.type === "tool"
}

function describeSession(info: SessionInfo): string {
  return `outcome ${info.outcome ?? "pending"}, model ${info.model == null ? "unset" : modelLabel(info.model)}`
}
