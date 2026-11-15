/**
 * #61 real-host positive protocol runner — plan asset, not executed here.
 *
 * The parent supplies a verification worktree whose only source difference is
 * a static candidate tuple. This runner loads that complete plugin through the
 * real host, drives the key path with the deterministic research stub, and
 * never injects a receipt call or correlation from the runner.
 *
 * Run only after review:
 *   TMPDIR=/tmp WATCH61_POSITIVE_CONFIRM=1 \
 *   WATCH61_VERIFICATION_PLUGIN=/path/to/verification-worktree \
 *   bun scripts/research/watchdog-61/positive-runner.ts
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"

import { OpenCode, type JsonValue } from "@opencode/client"

import { createClient, type SessionMessage } from "../../harness/client.ts"
import { MISSING, readLiveService } from "../../harness/isolation.ts"
import { isPortOpen, prepareScratch, startInstance, type InstanceHandle } from "../../harness/instance.ts"
import { STUB_MODEL_ID, STUB_PROVIDER_ID, defaultScratchRoot, scratchLayout, serviceJsonPath } from "../../harness/paths.ts"
import { sleep } from "../../harness/instance.ts"
import { promptForResult, toolCalls, waitForCall, type ToolCall } from "../../harness/stub/transcript.ts"
import { messageText } from "../../harness/sessions.ts"
import type { HarnessOptions } from "../../harness/args.ts"
import { readWatchGrantPayload, readWatchPayload, type WatchPayload } from "../../../src/rpc.ts"
import { BEGIN_MARKER, DUPLICATE_MARKER, WRONG_CALLER_MARKER, startPositiveStub } from "./positive-stub.ts"

if (process.env["WATCH61_POSITIVE_CONFIRM"] !== "1") {
  console.error("refusing to start an opencode service without WATCH61_POSITIVE_CONFIRM=1")
  process.exit(2)
}
const pluginPath = process.env["WATCH61_VERIFICATION_PLUGIN"]
if (pluginPath === undefined || pluginPath.length === 0) {
  console.error("WATCH61_VERIFICATION_PLUGIN must point at the reviewed verification worktree")
  process.exit(2)
}

const opencodeBin = process.env["WATCH61_OPENCODE_BIN"] ?? "/usr/bin/opencode"
const root = mkdtempSync(join(defaultScratchRoot(), "watchdog-61-positive-"))
const layout = scratchLayout(root, "positive")
const base: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"],
  HOME: join(layout.root, "home"),
  TMPDIR: join(layout.root, "tmp"),
  LANG: process.env["LANG"] ?? "C.UTF-8",
  LC_ALL: process.env["LC_ALL"] ?? "C.UTF-8",
  TZ: process.env["TZ"] ?? "UTC",
}
mkdirSync(base["HOME"] as string, { recursive: true, mode: 0o700 })
mkdirSync(base["TMPDIR"] as string, { recursive: true, mode: 0o700 })

const liveService = serviceJsonPath()
const before = readLiveService(liveService)
const stub = await startPositiveStub()
let instance: InstanceHandle | undefined
let failure: string | undefined
const evidence: string[] = []

try {
  prepareScratch(layout, {
    plugins: [
      {
        package: pluginPath,
        options: { watch: { idleMs: 2_000, runningSilentMs: 10_000, waitOverdueMs: 60_000, tickMs: 500 } },
      },
    ],
    stub: true,
  })
  instance = await startInstance({
    layout,
    password: `watch61-positive-${crypto.randomUUID()}`,
    opencodeBin,
    bootTimeoutMs: 60_000,
    env: base,
    stubBaseUrl: `${stub.url}/v1`,
  })
  const client = createClient(instance.url, instance.password)
  await client.models(layout.projectA)
  const target = await client.createSession({
    directory: layout.projectA,
    title: "watchdog-61-target",
    model: { providerID: STUB_PROVIDER_ID, id: STUB_MODEL_ID },
  })
  const authorization = `Basic ${Buffer.from(`opencode:${instance.password}`).toString("base64")}`
  const sdk = OpenCode.make({ baseUrl: instance.url, headers: { authorization } })
  const rpc = async (method: string, input: unknown): Promise<unknown> => {
    const result = await sdk.rpc.call({
      rpcID: "session-peers.v1",
      method,
      location: { directory: layout.projectA },
      input: input as JsonValue,
    })
    return (result as { output?: unknown }).output
  }
  const watch = async (input: unknown): Promise<WatchPayload> => {
    const payload = readWatchPayload(await rpc("watch", input))
    if (payload === undefined) throw new Error("the watch RPC answer was not understood")
    return payload
  }
  const options = { turnTimeoutMs: 60_000 } as HarnessOptions

  const enrolled = await watch({
    operation: "enroll",
    sessionID: target.id,
    requestId: "positive-enroll",
    goal: "prove the first real correction loop",
  })
  if (enrolled.task === null) throw new Error(`enroll failed: ${JSON.stringify(enrolled.failure)}`)
  const taskID = enrolled.task.taskID
  evidence.push(`enrolled ${taskID} without a prompt`)

  const begin = await promptForResult(
    client,
    options,
    target.id,
    `${BEGIN_MARKER} taskID=${taskID} version=${enrolled.task.version} reportId=positive-begin`,
  )
  if (begin.name !== "peers" || watchMeta(begin)?.["ok"] !== true) throw new Error("begin report failed")
  evidence.push("target called peers watch report begin through the real tool")

  let shown = await watch({ operation: "show", sessionID: target.id, taskID })
  if (shown.task === null) throw new Error("the task disappeared after begin")
  const prepared = readWatchGrantPayload(
    await rpc("watchGrant", {
      operation: "prepare",
      sessionID: target.id,
      taskID,
      expectedVersion: shown.task.version,
      deployment: "single-host-same-location",
    }),
  )
  if (prepared?.challenge === null || prepared?.challenge === undefined) {
    throw new Error(`grant prepare failed: ${prepared?.failure?.code ?? "unknown"}`)
  }
  const confirmed = readWatchGrantPayload(
    await rpc("watchGrant", {
      operation: "confirm",
      sessionID: target.id,
      taskID,
      expectedVersion: prepared.challenge.expectedVersion,
      generation: prepared.challenge.generation,
      termsDigest: prepared.challenge.termsDigest,
      challenge: prepared.challenge.challenge,
      deployment: "single-host-same-location",
    }),
  )
  if (confirmed?.ok !== true) throw new Error(`grant confirm failed: ${confirmed?.failure?.code ?? "unknown"}`)
  evidence.push("controlled RPC granted limited correction with the explicit deployment declaration")

  const correction = await waitForCorrectionPrompt(client, target.id, 120_000)
  const prompt = parseCorrectionPrompt(correction)
  evidence.push(`automatic queue produced one correction prompt for attempt ${prompt.attemptID}`)

  const receipt = await waitForCall(
    client,
    target.id,
    (call) => call.name === "peers" && operationOf(call) === "receipt",
    60_000,
  )
  if (receipt === undefined) throw new Error("the target never called receipt")
  if (watchMeta(receipt)?.["continuePermit"] !== true) {
    throw new Error("the target receipt did not get a continue permit")
  }
  evidence.push("target tool receipt received one continue permit")

  const recovered = await waitForRecovery(async () => watch({ operation: "show", sessionID: target.id, taskID }), 60_000)
  if (!recovered) throw new Error("the new progress did not produce recovery")
  evidence.push("new progress plus new result reference produced recovered")

  shown = await watch({ operation: "show", sessionID: target.id, taskID })
  if (shown.task === null) throw new Error("the task disappeared")
  const used = shown.task.attempts.used
  const queueMessages = await client.context(target.id)
  if (queueCount(queueMessages) !== 1 || used !== 1) {
    throw new Error(`expected one queue prompt and one permanent attempt, got ${queueCount(queueMessages)}/${used}`)
  }
  if (JSON.stringify(shown).includes(prompt.correlation)) {
    throw new Error("the normal show leaked the dispatch correlation")
  }
  evidence.push("queue prompts exactly 1 and permanent attempts exactly 1")
  evidence.push("normal show did not contain the correlation")

  await client.prompt(
    target.id,
    `${DUPLICATE_MARKER} taskID=${prompt.taskID} attemptID=${prompt.attemptID} correlation=${prompt.correlation}`,
  )
  const duplicate = await waitForCall(
    client,
    target.id,
    (call) =>
      call.name === "peers" &&
      operationOf(call) === "receipt" &&
      call.metadata["duplicate"] === true,
    60_000,
  )
  if (
    duplicate === undefined ||
    watchMeta(duplicate)?.["duplicate"] !== true ||
    watchMeta(duplicate)?.["continuePermit"] !== false
  ) {
    throw new Error("the duplicate receipt was not observed as duplicate/no-permit")
  }
  evidence.push("duplicate receipt returned no second permit")

  const other = await client.createSession({
    directory: layout.projectA,
    title: "watchdog-61-other-caller",
    model: { providerID: STUB_PROVIDER_ID, id: STUB_MODEL_ID },
  })
  await client.prompt(
    other.id,
    `${WRONG_CALLER_MARKER} taskID=${prompt.taskID} attemptID=${prompt.attemptID} correlation=${prompt.correlation}`,
  )
  const wrong = await waitForCall(
    client,
    other.id,
    (call) => call.name === "peers" && operationOf(call) === "receipt",
    60_000,
  )
  if (wrong === undefined) throw new Error("the wrong caller never reached receipt")
  const wrongFailure = watchMeta(wrong)?.["failure"] as { code?: string } | undefined
  if (wrongFailure?.code !== "E_WATCH_CALLER_MISMATCH") {
    throw new Error("wrong caller was not refused with E_WATCH_CALLER_MISMATCH")
  }
  const finalMessages = await client.context(target.id)
  if (queueCount(finalMessages) !== 1) throw new Error("duplicate/wrong caller produced another correction prompt")
  const permitCalls = finalMessages
    .flatMap((message) => toolCalls([message]))
    .filter((call) => call.name === "peers" && operationOf(call) === "receipt" && watchMeta(call)?.["continuePermit"] === true)
  if (permitCalls.length !== 1) throw new Error(`expected exactly one continue permit, got ${permitCalls.length}`)
  evidence.push("duplicate/wrong-caller produced no second correction or continue permit")
  evidence.push("a different local session was refused with E_WATCH_CALLER_MISMATCH")
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
} finally {
  let stop: { stopped: boolean; portClosed: boolean; observed: string } | undefined
  if (instance !== undefined) {
    try {
      stop = await instance.stop()
    } catch (error) {
      stop = { stopped: false, portClosed: false, observed: String(error) }
    }
  }
  let stubStopError: string | undefined
  let stubPortClosed = false
  try {
    await stub.stop()
    stubPortClosed = !(await isPortOpen(stub.port))
  } catch (error) {
    stubStopError = error instanceof Error ? error.message : String(error)
  }
  const after = readLiveService(liveService)
  const report = {
    ok:
      failure === undefined &&
      stop?.stopped === true &&
      stop.portClosed === true &&
      stubStopError === undefined &&
      stubPortClosed &&
      before.digest === after.digest,
    failure: failure ?? null,
    evidence,
    childPid: instance?.pid ?? null,
    stopped: stop?.stopped ?? null,
    portClosed: stop?.portClosed ?? null,
    stopObserved: stop?.observed ?? null,
    stubStopped: stubStopError === undefined,
    stubPortClosed,
    stubStopError: stubStopError ?? null,
    liveServiceDigestBefore: before.digest,
    liveServiceDigestAfter: after.digest,
    liveServiceUntouched: before.digest === after.digest,
    serviceJsonState: before.digest === MISSING ? "missing" : "present",
    scratchRoot: layout.root,
    serverLog: layout.serverLog,
  }
  console.log(JSON.stringify(report, null, 2))
  if (report.ok && process.env["WATCH61_KEEP_SCRATCH"] !== "1") rmSync(layout.root, { recursive: true, force: true })
  if (!report.ok) process.exitCode = 1
}

async function waitForCorrectionPrompt(
  client: ReturnType<typeof createClient>,
  sessionID: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const messages = await client.context(sessionID)
    const found = messages.find(
      (message) => message.type === "user" && messageText(message).includes("[session-peers correction]"),
    )
    if (found !== undefined) return messageText(found)
    await sleep(250)
  }
  throw new Error("the automatic correction prompt never appeared")
}

function parseCorrectionPrompt(text: string): {
  readonly taskID: string
  readonly attemptID: string
  readonly correlation: string
} {
  const parsed = /peers\((\{.*\})\)/.exec(text)?.[1]
  if (parsed === undefined) throw new Error("the correction prompt carried no concrete receipt JSON")
  const call = JSON.parse(parsed) as { watch?: { taskID?: string; attemptID?: string; correlation?: string } }
  if (call.watch?.taskID === undefined || call.watch.attemptID === undefined || call.watch.correlation === undefined) {
    throw new Error("the correction prompt JSON was incomplete")
  }
  return { taskID: call.watch.taskID, attemptID: call.watch.attemptID, correlation: call.watch.correlation }
}

function watchMeta(call: ToolCall): Record<string, unknown> | undefined {
  const meta = call.metadata["watch"]
  return typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : undefined
}

function queueCount(messages: readonly SessionMessage[]): number {
  return messages.filter((message) => message.type === "user" && messageText(message).includes("[session-peers correction]"))
    .length
}

function operationOf(call: ToolCall): string | undefined {
  const input = call.input
  if (typeof input !== "object" || input === null) return undefined
  const watch = (input as { watch?: unknown }).watch
  if (typeof watch !== "object" || watch === null) return undefined
  const operation = (watch as { operation?: unknown }).operation
  return typeof operation === "string" ? operation : undefined
}

async function waitForRecovery(
  show: () => Promise<WatchPayload>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const payload = await show()
    const phase = payload.task?.correction.history[0]?.phase
    if (phase === "recovered") return true
    await sleep(250)
  }
  return false
}
