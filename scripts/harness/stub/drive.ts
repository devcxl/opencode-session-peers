/**
 * The offline driven pass.
 *
 * Two sessions in two directories are driven through the harness's own stub
 * model, and the pass asserts the one thing the structural pass cannot: a
 * message sent from the session in one directory appears in the session in the
 * other. Nothing here leaves loopback and no credential is read.
 *
 * The stub is a script, not a model, so the transcript is checked rather than
 * the answers being judged: A's `peers` tool result must say the message was
 * delivered, and the token the harness wrote into the prompt must be there in
 * B's transcript afterwards.
 */

import { drivenModel, modelLabel, type HarnessOptions } from "../args.ts"
import type { HarnessClient, SessionMessage, SessionToolPart } from "../client.ts"
import { sleep } from "../instance.ts"
import type { Expectation, SessionSummary } from "../report.ts"
import { requireModel, messageText } from "../sessions.ts"
import { LIST_PROMPT, sendPrompt } from "./model-server.ts"

/**
 * The token the harness sends. Fixed, so two runs of the pass produce the same
 * result; it is the evidence that the same message crossed the directory
 * boundary, not a coincidence.
 */
export const CROSSING_TOKEN = "HARNESS_OFFLINE_MESSAGE_OK"

/**
 * How long the roster may take to show the other session. The plugin publishes
 * from a live event stream, so this is a settle window rather than a wait on a
 * slow operation; it is bounded so a pass that cannot see the peer fails with
 * the reason instead of hanging.
 */
const ROSTER_WAIT_MS = 20_000
const POLL_MS = 500

/** One tool call from a transcript, with its result. */
interface ToolCall {
  name: string
  input: unknown
  text: string
  metadata: Readonly<Record<string, unknown>>
}

export async function driveStubPass(
  client: HarnessClient,
  options: HarnessOptions,
  sessions: readonly SessionSummary[],
  expectations: Expectation[],
  disclosures: string[],
): Promise<SessionSummary[]> {
  const model = drivenModel(options)
  if (model === undefined) throw new Error("the offline pass needs the stub model, but none is configured")

  await requireModel(client, model, sessions[0]!.directory, expectations)

  const [sessionA, sessionB] = sessions
  if (sessionA === undefined || sessionB === undefined || sessionA.id === sessionB.id) {
    throw new Error("the offline pass needs two distinct sessions")
  }

  await waitForRoster(client, options, sessionA, sessionB, expectations)

  const sent = await sendAndCheckDelivery(client, options, sessionA, sessionB, expectations)
  if (!sent) throw new Error(`session ${sessionA.label} did not report the message to ${sessionB.label} as delivered`)

  await waitForCrossing(client, options, sessionA, sessionB, expectations)

  disclosures.push(
    `the offline pass drove every turn through the harness's stub model (${modelLabel(model)}); no hosted model and no credential were involved`,
  )
  return [...sessions]
}

/**
 * A's own roster view must name B before anything is sent: the plugin publishes
 * from a live event stream, so the peer can briefly lag behind its creation,
 * and asking again is how the harness observes the roster rather than assumes
 * it. The transcript is bounded by the turn timeout, so a roster that never
 * shows the peer fails the run with the state it stalled in.
 */
async function waitForRoster(
  client: HarnessClient,
  options: HarnessOptions,
  sessionA: SessionSummary,
  sessionB: SessionSummary,
  expectations: Expectation[],
): Promise<void> {
  const expected = `session ${sessionA.label} sees session ${sessionB.label} on the roster`
  const deadline = Date.now() + ROSTER_WAIT_MS
  let attempts = 0
  let last: string = "no roster view was read"

  while (Date.now() < deadline) {
    attempts += 1
    const call = await promptForTool(client, options, sessionA.id, LIST_PROMPT)
    last = call.text
    if (last.includes(sessionA.id) && last.includes(sessionB.id)) {
      expectations.push({
        name: "peers-visible",
        met: true,
        expected,
        observed: `both session ids appear in ${sessionA.label}'s roster view after ${attempts} ask(s)`,
      })
      return
    }
    await sleep(POLL_MS)
  }

  expectations.push({
    name: "peers-visible",
    met: false,
    expected,
    observed: `${sessionA.label}'s roster view after ${attempts} ask(s) never named both sessions: ${oneLine(last)}`,
  })
  throw new Error(`${sessionA.label} never saw ${sessionB.label} on the roster`)
}

/** A sends one message to B; the tool result has to report it delivered. */
async function sendAndCheckDelivery(
  client: HarnessClient,
  options: HarnessOptions,
  sessionA: SessionSummary,
  sessionB: SessionSummary,
  expectations: Expectation[],
): Promise<boolean> {
  const expected = `sending from ${sessionA.label} to ${sessionB.label} reports the message delivered`
  try {
    // The directive names the peer by title, so the stub can write the tool call
    // the way a model would: a target the harness created and knows.
    const call = await promptForTool(client, options, sessionA.id, sendPrompt(sessionB.title, CROSSING_TOKEN))
    const delivered = call.metadata["delivered"] === true
    expectations.push({
      name: "message-delivered",
      met: delivered,
      expected,
      observed: delivered ? oneLine(call.text) : `not delivered: ${oneLine(call.text)}`,
    })
    return delivered
  } catch (error) {
    expectations.push({
      name: "message-delivered",
      met: false,
      expected,
      observed: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/** The token has to arrive in B's own transcript, by way of B's own directory. */
async function waitForCrossing(
  client: HarnessClient,
  options: HarnessOptions,
  sessionA: SessionSummary,
  sessionB: SessionSummary,
  expectations: Expectation[],
): Promise<void> {
  const expected = `the message sent in ${sessionA.directory} appears in the session in ${sessionB.directory}`
  const deadline = Date.now() + options.turnTimeoutMs

  for (;;) {
    const messages = await client.context(sessionB.id)
    const carrier = messages.find(
      (message) => message.type === "user" && messageText(message).includes(CROSSING_TOKEN),
    )
    if (carrier !== undefined) {
      expectations.push({
        name: "message-crossed-directories",
        met: true,
        expected,
        observed: `${CROSSING_TOKEN} is in ${sessionB.label}'s transcript in ${sessionB.directory}, sent from ${sessionA.directory}`,
      })
      return
    }
    if (Date.now() >= deadline) {
      expectations.push({
        name: "message-crossed-directories",
        met: false,
        expected,
        observed: `${CROSSING_TOKEN} never appeared in ${sessionB.label}'s ${messages.length} message(s) within ${options.turnTimeoutMs} ms`,
      })
      throw new Error(`${CROSSING_TOKEN} never reached ${sessionB.label}`)
    }
    await sleep(POLL_MS)
  }
}

/**
 * Ask a session to run one scripted turn and return the tool call it produced.
 * The wait is on the transcript, not on the session's `outcome`: a session that
 * already succeeded keeps that outcome, so the only reliable signal for *this*
 * turn is one more tool result than there was before.
 */
async function promptForTool(
  client: HarnessClient,
  options: HarnessOptions,
  sessionID: string,
  prompt: string,
): Promise<ToolCall> {
  const before = toolCalls(await client.context(sessionID)).length
  await client.prompt(sessionID, prompt)
  const deadline = Date.now() + options.turnTimeoutMs

  for (;;) {
    const calls = toolCalls(await client.context(sessionID))
    if (calls.length > before) return calls.at(-1)!
    if (Date.now() >= deadline) {
      throw new Error(`the stub turn in ${sessionID} produced no tool call within ${options.turnTimeoutMs} ms`)
    }
    await sleep(POLL_MS)
  }
}

function toolCalls(messages: readonly SessionMessage[]): ToolCall[] {
  return messages.flatMap((message) =>
    (message.content ?? [])
      .filter((part): part is SessionToolPart => part.type === "tool")
      .map((part) => ({
        name: part.name,
        input: part.state?.input,
        text: (part.state?.content ?? []).map((entry) => entry.text ?? "").join(""),
        metadata: part.state?.metadata ?? {},
      })),
  )
}

function oneLine(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}...`
}
