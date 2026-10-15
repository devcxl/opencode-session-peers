/**
 * The ask phases of the offline pass.
 *
 * A user reported that an `ask` never returned, and the code alone cannot say
 * which of two things happened: nobody answered and the caller waited out its
 * timeout, or the ask chain itself is broken. The offline pass drives both
 * outcomes on the real chain, under one short configured `askTimeoutMs`, so a
 * run tells them apart:
 *
 *   - a question the peer's script leaves unanswered must come back as the
 *     timeout text, about the configured timeout after the call started — not
 *     after the ten-minute default;
 *   - a question the peer's script answers must come back with the peer's own
 *     words, with the peer's reply call visible in its own transcript.
 *
 * This is a reproduction, not a diagnosis: it asserts what the chain does, and
 * asserts nothing about why.
 */

import type { HarnessOptions } from "../args.ts"
import type { HarnessClient } from "../client.ts"
import { explain, type Expectation, type SessionSummary } from "../report.ts"
import { messageText } from "../sessions.ts"
import { STUB_ANSWER_TEXT, STUB_REPLY_DIRECTIVE, askPrompt } from "./model-server.ts"
import { type ToolCall, elapsedInCall, oneLine, promptForResult, waitForCall } from "./transcript.ts"

/** The configuration the pass runs the ask chain under; the instance is booted with it. */
export interface AskPlan {
  /** The `askTimeoutMs` the plugin under test is configured with, in both projects. */
  readonly timeoutMs: number
}

/**
 * The one plan the offline pass runs. Long enough that the peer's reply has
 * room to arrive on a slow machine, short enough that an unanswered ask costs
 * seconds rather than the default ten minutes.
 */
export const STUB_ASK_PLAN: AskPlan = { timeoutMs: 10_000 }

/** The plugin's own default (`DEFAULT_CONFIG.askTimeoutMs`), named so the pass can say what it is not. */
const DEFAULT_ASK_TIMEOUT_MS = 600_000

/** The sentence a timed-out ask must carry, ported from pi-intercom with the text. */
const TIMEOUT_MARKER = "This waiter timeout is not cancellation"

/** The question body the peer's script leaves unanswered. */
export const UNANSWERED_QUESTION = "HARNESS_OFFLINE_QUESTION"

/** How long the peer's own reply call may take to show up after the asker returned. */
const PEER_CALL_WAIT_MS = 15_000

/** How much of the configured timeout a measured wait may fall short of. */
const ELAPSED_FLOOR = 0.9

/** How far past the configured timeout the wait may land: poll granularity and scheduling. */
const ELAPSED_CEILING_MS = 20_000

export async function driveAskPass(
  client: HarnessClient,
  options: HarnessOptions,
  sessionA: SessionSummary,
  sessionB: SessionSummary,
  expectations: Expectation[],
  plan: AskPlan,
): Promise<void> {
  await driveUnansweredAsk(client, options, sessionA, sessionB, expectations, plan)
  await driveAnsweredAsk(client, options, sessionA, sessionB, expectations)
}

/**
 * The question nobody answers: the peer's script reads the question token and
 * has nothing scripted for it, so no reply is ever written and the asker's
 * deadline is the only thing that can end the call.
 */
async function driveUnansweredAsk(
  client: HarnessClient,
  options: HarnessOptions,
  sessionA: SessionSummary,
  sessionB: SessionSummary,
  expectations: Expectation[],
  plan: AskPlan,
): Promise<void> {
  const startedAt = Date.now()
  let call: ToolCall
  try {
    call = await promptForResult(client, options, sessionA.id, askPrompt(sessionB.title, UNANSWERED_QUESTION))
  } catch (error) {
    expectations.push({
      name: "ask-timeout-returned",
      met: false,
      expected: `an ask the peer never answers returns within ${options.turnTimeoutMs} ms`,
      observed: explain(error),
    })
    throw error
  }
  const wallClockMs = Date.now() - startedAt
  const inCallMs = elapsedInCall(call)

  const named = `No reply from "${sessionB.title}" for message`
  const duration = `within ${plan.timeoutMs}ms`
  const timedOut = call.metadata["answered"] === false && call.metadata["code"] === "E_ASK_TIMEOUT"
  const text = call.text.includes(TIMEOUT_MARKER) && call.text.includes(named) && call.text.includes(duration)
  expectations.push({
    name: "ask-timeout-returned",
    met: timedOut && text,
    expected: `the unanswered ask returns the timeout text naming the configured ${plan.timeoutMs} ms`,
    observed:
      `${call.name} ${JSON.stringify(call.input)} — ${oneLine(call.text)} ` +
      `[answered=${String(call.metadata["answered"])} code=${String(call.metadata["code"])}]`,
  })

  // The measurement the ticket asks for: the configured timeout, not the
  // default. The host's own record of the call is the tightest one; the wall
  // clock around the prompt is the fallback, and it includes the turn's start.
  const measured = inCallMs ?? wallClockMs
  const source = inCallMs === undefined ? "wall clock around the prompt" : "the host's own ran to completed"
  const tracked = measured >= plan.timeoutMs * ELAPSED_FLOOR && measured <= plan.timeoutMs + ELAPSED_CEILING_MS
  expectations.push({
    name: "ask-timeout-elapsed",
    met: tracked,
    expected:
      `the call waited about the configured ${plan.timeoutMs} ms, ` +
      `not the plugin's ${DEFAULT_ASK_TIMEOUT_MS} ms default`,
    observed: `${measured} ms from ${source} (${wallClockMs} ms around the prompt)`,
  })

  await checkQuestionArrived(client, sessionB, expectations)
}

/** The question must be in the peer's own transcript; "nobody answered" is not "nothing arrived". */
async function checkQuestionArrived(
  client: HarnessClient,
  sessionB: SessionSummary,
  expectations: Expectation[],
): Promise<void> {
  const messages = await client.context(sessionB.id)
  const carrier = messages.find(
    (message) => message.type === "user" && messageText(message).includes(UNANSWERED_QUESTION),
  )
  expectations.push({
    name: "ask-question-arrived",
    met: carrier !== undefined,
    expected: `the unanswered question is in ${sessionB.label}'s transcript, in ${sessionB.directory}`,
    observed:
      carrier === undefined
        ? `no user message carrying ${UNANSWERED_QUESTION} in ${messages.length} message(s)`
        : `${UNANSWERED_QUESTION} is in ${sessionB.label}'s transcript`,
  })
}

/** The question the peer's script answers, from the token the harness wrote into it. */
async function driveAnsweredAsk(
  client: HarnessClient,
  options: HarnessOptions,
  sessionA: SessionSummary,
  sessionB: SessionSummary,
  expectations: Expectation[],
): Promise<void> {
  let call: ToolCall
  try {
    call = await promptForResult(client, options, sessionA.id, askPrompt(sessionB.title, STUB_REPLY_DIRECTIVE))
  } catch (error) {
    expectations.push({
      name: "ask-answered-returned",
      met: false,
      expected: `an ask the peer answers returns within ${options.turnTimeoutMs} ms`,
      observed: explain(error),
    })
    throw error
  }

  const answered = call.metadata["answered"] === true
  const returned = call.text.includes(STUB_ANSWER_TEXT) && call.text.includes(sessionB.title)
  // The wait is reported too: it is the margin the peer's reply had, and the
  // evidence that the answer arrived inside the configured timeout at all.
  const answeredInMs = elapsedInCall(call)
  const waited = answeredInMs === undefined ? "" : `, wait ${answeredInMs} ms`
  expectations.push({
    name: "ask-answered-returned",
    met: answered && returned,
    expected: `the answered ask returns ${sessionB.title}'s own words`,
    observed: `${call.name} ${JSON.stringify(call.input)} — ${oneLine(call.text)} [answered=${String(answered)}${waited}]`,
  })

  const reply = await waitForCall(client, sessionB.id, isPeersReply, PEER_CALL_WAIT_MS)
  expectations.push({
    name: "ask-peer-replied",
    met: reply !== undefined,
    expected: `${sessionB.label} ran a peers reply call of its own`,
    observed:
      reply === undefined
        ? `no peers reply call appeared in ${sessionB.label}'s transcript within ${PEER_CALL_WAIT_MS} ms`
        : `${sessionB.label} replied: ${oneLine(reply.text)}`,
  })
}

function isPeersReply(call: ToolCall): boolean {
  return call.name === "peers" && (call.input as { action?: unknown } | undefined)?.action === "reply"
}
