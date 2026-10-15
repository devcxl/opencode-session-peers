/**
 * The offline driven pass.
 *
 * Two sessions in two directories are driven through the harness's own stub
 * model, and the pass asserts what the structural pass cannot: a message sent
 * from the session in one directory appears in the session in the other — as a
 * plain body, with no reply instruction a receiver could not act on (issue
 * #24) — and an `ask` comes back, with the answer when the peer replies and
 * with the timeout text when it does not. Nothing here leaves loopback and no
 * credential is read.
 *
 * The stub is a script, not a model, so the transcript is checked rather than
 * the answers being judged: A's `peers` tool result must say what the call did,
 * and the tokens the harness wrote into the prompt must be there in B's
 * transcript afterwards.
 */

import { drivenModel, modelLabel, type HarnessOptions } from "../args.ts"
import type { HarnessClient } from "../client.ts"
import { sleep } from "../instance.ts"
import type { Expectation, SessionSummary } from "../report.ts"
import { requireModel, messageText } from "../sessions.ts"
import { driveAskPass, STUB_ASK_PLAN, type AskPlan } from "./ask.ts"
import { LIST_PROMPT, sendPrompt } from "./model-server.ts"
import { oneLine, promptForResult } from "./transcript.ts"

/**
 * The token the harness sends. Fixed, so two runs of the pass produce the same
 * result; it is the evidence that the same message crossed the directory
 * boundary, not a coincidence.
 */
export const CROSSING_TOKEN = "HARNESS_OFFLINE_MESSAGE_OK"

/**
 * The instruction a question carries. The offline pass sends a plain message,
 * so the body the peer receives must not tell it to `reply`: a send opens no
 * ask to answer.
 */
export const REPLY_HINT = `To reply: peers({ action: "reply", message: "..." })`

/**
 * How long the roster may take to show the other session. The plugin publishes
 * from a live event stream, so this is a settle window rather than a wait on a
 * slow operation; it is bounded so a pass that cannot see the peer fails with
 * the reason instead of hanging.
 */
const ROSTER_WAIT_MS = 20_000
const POLL_MS = 500

/**
 * The plan is a parameter because the instance is booted with it: the unit
 * tests run the same phases under a shorter timeout instead of waiting the
 * configured one out.
 */
export async function driveStubPass(
  client: HarnessClient,
  options: HarnessOptions,
  sessions: readonly SessionSummary[],
  expectations: Expectation[],
  disclosures: string[],
  plan: AskPlan = STUB_ASK_PLAN,
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

  await driveAskPass(client, options, sessionA, sessionB, expectations, plan)

  disclosures.push(
    `the offline pass drove every turn through the harness's stub model (${modelLabel(model)}); ` +
      "no hosted model and no credential were involved",
  )
  disclosures.push(
    `the offline pass configured the plugin under test with askTimeoutMs ${plan.timeoutMs} ms ` +
      "in both project configs, so the timeout it asserts is the configured one, not the default",
  )
  return [...sessions]
}

/**
 * A's own roster view must name B before anything is sent: the plugin publishes
 * from a live event stream, so the peer can briefly lag behind its creation,
 * and asking again is how the harness observes the roster rather than assumes
 * it. The wait is bounded, so a roster that never shows the peer fails the run
 * with the state it stalled in instead of hanging.
 */async function waitForRoster(
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
    const call = await promptForResult(client, options, sessionA.id, LIST_PROMPT)
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
    const call = await promptForResult(client, options, sessionA.id, sendPrompt(sessionB.title, CROSSING_TOKEN))
    const asked = call.input as { action?: unknown; to?: unknown } | undefined
    // The name and the input are checked too: a turn that produced some other
    // tool result must not read as a delivered message.
    const sent =
      call.name === "peers" && asked?.action === "send" && asked.to === sessionB.title
    const delivered = sent && call.metadata["delivered"] === true
    expectations.push({
      name: "message-delivered",
      met: delivered,
      expected,
      observed: `${call.name} ${JSON.stringify(call.input)} — ${delivered ? "" : "not delivered: "}${oneLine(call.text)}`,
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
        observed:
          `${CROSSING_TOKEN} is in ${sessionB.label}'s transcript in ${sessionB.directory}, ` +
          `sent from ${sessionA.directory}`,
      })
      expectations.push(hintCheck(sessionB, messageText(carrier)))
      return
    }
    if (Date.now() >= deadline) {
      expectations.push({
        name: "message-crossed-directories",
        met: false,
        expected,
        observed:
          `${CROSSING_TOKEN} never appeared in ${sessionB.label}'s ${messages.length} message(s) ` +
          `within ${options.turnTimeoutMs} ms`,
      })
      throw new Error(`${CROSSING_TOKEN} never reached ${sessionB.label}`)
    }
    await sleep(POLL_MS)
  }
}

/**
 * The body of a plain send carries no reply instruction: the receiver's `reply`
 * would have no ask to match, so the line would only send it to a refusal. The
 * check lives next to the crossing because the body it reads is the evidence
 * the crossing found.
 */
function hintCheck(sessionB: SessionSummary, body: string): Expectation {
  const carries = body.includes(REPLY_HINT)
  return {
    name: "send-carries-no-reply-hint",
    met: !carries,
    expected: "the body a plain send delivers carries no reply instruction",
    observed: carries
      ? `${sessionB.label}'s message tells the receiver to reply, but a send opens no ask to answer`
      : `the message in ${sessionB.label}'s transcript carries sender and body only`,
  }
}

