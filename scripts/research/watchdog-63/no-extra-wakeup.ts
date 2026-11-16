/**
 * #63 isolated real-host delegation/no-extra-wakeup runner — plan asset.
 *
 * It loads the complete reviewed plugin through a real isolated host and the
 * deterministic offline stub. The child is created by one real `subagent` tool
 * turn (the public create API has no parentID), then verified through the
 * public session API. The controlled delegation grant, public `delegate`, child
 * begin, correction receipt/progress, revoke-before-receipt and scope-change
 * variants are driven through public entry points only.
 *
 * It refuses to start without explicit confirmation, a reviewed plugin path and
 * the approved patched binary. It never starts a live/default service, never
 * reads a host database or credentials and never prints prompts, goals,
 * challenges, correlations or the server password.
 *
 * Run only after review:
 *   TMPDIR=/tmp WATCH63_REAL_CONFIRM=1 \
 *   WATCH63_PLUGIN=/path/to/final-integration \
 *   WATCH63_OPENCODE_BIN=/path/to/patched/opencode \
 *   WATCH63_SCENARIO=positive \
 *   bun scripts/research/watchdog-63/no-extra-wakeup.ts
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"

import { OpenCode, type JsonValue } from "@opencode/client"

import type { HarnessOptions } from "../../harness/args.ts"
import { createClient, type SessionMessage } from "../../harness/client.ts"
import { MISSING, readLiveService } from "../../harness/isolation.ts"
import {
  isPortOpen,
  prepareScratch,
  sleep,
  startInstance,
  type InstanceHandle,
} from "../../harness/instance.ts"
import { STUB_MODEL_ID, STUB_PROVIDER_ID, defaultScratchRoot, serviceJsonPath } from "../../harness/paths.ts"
import { isTerminal, promptForResult, waitForCall, type ToolCall } from "../../harness/stub/transcript.ts"
import { messageText, waitForOutcome } from "../../harness/sessions.ts"
import { candidateLayout } from "../watchdog-61/candidate-layout.ts"
import {
  CHILD_BEGIN_MARKER,
  CORRECTION_PREFIX,
  DUPLICATE_MARKER,
  PARENT_BEGIN_MARKER,
  PARENT_DELEGATE_MARKER,
  PARENT_RECEIPT_MARKER,
  PARENT_SUBAGENT_MARKER,
  countMessages,
  countNativeSubagentReports,
  parseCorrectionCall,
  scenarioFromValue,
  type MetadataMessage,
  type Scenario,
} from "./protocol.ts"
import { startWatch63Stub, type Watch63StubHandle } from "./stub.ts"

const EXPECTED_APP_VERSION = "2.3.0-watchdog-location.1"
const APPROVED_BINARY_SHA256 = "93c16b937359c226eb77691c7453c5fdadb2b716e1b6da7434d7cc8fc6c5cb7a"
const EXPECTED_SQLITE = "3.53.4"
const DATABASE_CHANNEL = "watchdog-location"
const GOAL_TOKEN = "WATCH63_PARENT_GOAL"
const POLL_MS = 500

interface Counts {
  readonly user: number
  readonly assistant: number
  readonly correction: number
  readonly synthetic: number
  readonly nativeHostReports: number
  readonly otherSynthetic: number
  readonly invalidNativeReports: number
  readonly inbox: number
  readonly inboxQueue: number
  readonly inboxSteer: number
  readonly inboxCorrectionQueue: number
  readonly inboxCorrectionSteer: number
  readonly outcome: string | null
}

interface Snapshot {
  readonly parent: Counts
  readonly child: Counts
}

interface LedgerLite {
  readonly available: boolean
  readonly reason: string | null
  readonly sqliteVersion: string | null
  readonly journalMode: string | null
  readonly synchronous: number | null
  readonly busyTimeoutMs: number | null
  readonly appVersion: string | null
  readonly platform: string | null
  readonly arch: string | null
}

interface AttemptLite {
  readonly phase?: string
  readonly receipt?: { readonly continuePermitIssuedAt?: number | null } | null
}

interface TaskLite {
  readonly taskID: string
  readonly version: number
  readonly attempts?: { readonly used: number }
  readonly correction?: { readonly history?: readonly AttemptLite[] }
}

interface WatchReply {
  readonly enabled: boolean
  readonly ledger: LedgerLite
  readonly task: TaskLite | null
  readonly failure?: { readonly code?: string } | null
}

interface ChallengeLite {
  readonly challenge: string
  readonly expectedVersion: number
  readonly generation: number
  readonly mode: string
  readonly scopeDirectory: string
  readonly scopePeerScope: string
  readonly termsDigest: string
}

interface DelegationGrantReply {
  readonly ok: boolean
  readonly challenge: ChallengeLite | null
  readonly grant: { readonly state?: string } | null
  readonly review?:
    | {
        readonly delegationTerms: string
        readonly correctionTerms: string
        readonly deploymentRequired: boolean
        readonly derivesCorrectionGrant: boolean
      }
    | undefined
  readonly failure?: { readonly code?: string } | null
}

interface DelegatedChildLite {
  readonly taskID: string
  readonly authorized: boolean
  readonly task: unknown
  readonly alerts: unknown
}

interface DelegationViewLite {
  readonly ok: boolean
  readonly children: readonly DelegatedChildLite[]
}

interface RawSession {
  readonly id: string
  readonly parentID?: string
  readonly outcome?: string
  readonly time?: { readonly updated?: number }
  readonly location?: { readonly directory?: string }
}

interface RawInbox {
  readonly type?: string
  readonly delivery?: string
  readonly payload?: { readonly text?: string }
}

async function main(): Promise<void> {
  if (process.env["WATCH63_REAL_CONFIRM"] !== "1") {
    console.error("refusing to start an opencode service without WATCH63_REAL_CONFIRM=1")
    process.exit(2)
  }
  if ((process.env["WATCH63_PLUGIN"] ?? "").length === 0) {
    console.error("refusing to run without WATCH63_PLUGIN")
    process.exit(2)
  }
  if ((process.env["WATCH63_OPENCODE_BIN"] ?? "").length === 0) {
    console.error("refusing to run without WATCH63_OPENCODE_BIN")
    process.exit(2)
  }
  const pluginPath = requiredAbsolutePath("WATCH63_PLUGIN")
  const opencodeBin = requiredAbsolutePath("WATCH63_OPENCODE_BIN")
  if (!statSync(pluginPath).isDirectory()) throw new RunnerFailure("WATCH63_PLUGIN must be a directory")
  if (!statSync(opencodeBin).isFile()) throw new RunnerFailure("WATCH63_OPENCODE_BIN must be a file")
  const binaryHash = createHash("sha256").update(readFileSync(opencodeBin)).digest("hex")
  if (binaryHash !== APPROVED_BINARY_SHA256) {
    throw new RunnerFailure("WATCH63_OPENCODE_BIN is not the approved patched artifact")
  }
  let scenario
  try {
    scenario = scenarioFromValue(process.env["WATCH63_SCENARIO"])
  } catch {
    console.error("WATCH63_SCENARIO must be positive, revoke or scope")
    process.exit(2)
  }
  const keep = process.env["WATCH63_KEEP_SCRATCH"] === "1"

  const root = mkdtempSync(join(defaultScratchRoot(), "watchdog-63-realhost-"))
  const layout = candidateLayout(root, "realhost", DATABASE_CHANNEL)
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
  const beforeRegistry = readLiveService(liveService)
  const evidence: string[] = []
  const explicit = { parent: 0, child: 0 }
  let stub: Watch63StubHandle | undefined
  let instance: InstanceHandle | undefined
  let failure: string | undefined
  let runtime: Record<string, unknown> | undefined
  let initialBaseline: Snapshot | undefined
  let enrollBaseline: Snapshot | undefined
  let beginBaseline: Snapshot | undefined
  let grantBaseline: Snapshot | undefined
  let childBeginSnapshot: Snapshot | undefined
  let baseline: Snapshot | undefined
  let afterDelegate: Snapshot | undefined
  let finalSnapshot: Snapshot | undefined
  let ids: Record<string, string | null> = {}
  let scenarioFacts: Record<string, unknown> = {}

  try {
    prepareScratch(layout, {
      plugins: [
        {
          package: pluginPath,
          options: {
            watch: {
              idleMs: 2_000,
              runningSilentMs: 10_000,
              waitOverdueMs: 60_000,
              tickMs: 500,
              correctionObservationMs: 300_000,
              correctionWindowMs: 1_200_000,
            },
          },
        },
      ],
      stub: true,
    })
    stub = await startWatch63Stub(scenario)
    instance = await startInstance({
      layout,
      password: `watch63-${crypto.randomUUID()}`,
      opencodeBin,
      bootTimeoutMs: 60_000,
      env: base,
      stubBaseUrl: `${stub.url}/v1`,
    })
    const client = createClient(instance.url, instance.password)
    await client.models(layout.projectA)
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
    const watch = async (input: unknown): Promise<WatchReply> => {
      const payload = readWatchReply(await rpc("watch", input))
      if (payload === undefined) throw new RunnerFailure("the watch RPC answer was not understood")
      return payload
    }
    const terms = await reviewedTerms(pluginPath)
    const options: HarnessOptions = {
      pluginPath,
      driveModel: true,
      stub: true,
      turnTimeoutMs: 60_000,
      bootTimeoutMs: 60_000,
      scratchRoot: root,
      keep,
      json: true,
    }
    const parent = await client.createSession({
      directory: layout.projectA,
      title: "watchdog-63-parent",
      model: { providerID: STUB_PROVIDER_ID, id: STUB_MODEL_ID },
    })
    ids = { parentSessionID: parent.id, childSessionID: null, parentTaskID: null, childTaskID: null }

    const runtimePayload = await watch({ operation: "show", sessionID: parent.id })
    runtime = {
      appVersion: runtimePayload.ledger.appVersion,
      platform: runtimePayload.ledger.platform,
      arch: runtimePayload.ledger.arch,
      sqliteVersion: runtimePayload.ledger.sqliteVersion,
      journalMode: runtimePayload.ledger.journalMode,
      synchronous: runtimePayload.ledger.synchronous,
      busyTimeoutMs: runtimePayload.ledger.busyTimeoutMs,
    }
    assert(
      runtimePayload.ledger.available &&
        runtimePayload.ledger.appVersion === EXPECTED_APP_VERSION &&
        runtimePayload.ledger.platform === "linux" &&
        runtimePayload.ledger.arch === "x64" &&
        runtimePayload.ledger.sqliteVersion === EXPECTED_SQLITE &&
        runtimePayload.ledger.journalMode === "wal" &&
        runtimePayload.ledger.synchronous === 2 &&
        (runtimePayload.ledger.busyTimeoutMs ?? 0) > 0,
      "the real RPC ledger facts are not the approved patched runtime",
    )
    evidence.push("real RPC ledger tuple and embedded SQLite facts verified")

    // A real subagent tool turn creates the direct child. The public create
    // input has no parentID, so this is the documented fallback; the child is
    // never created through the host database or an experimental import.
    explicit.parent += 1
    const subagentCall = await promptForResult(client, options, parent.id, PARENT_SUBAGENT_MARKER)
    assert(subagentCall.name === "subagent" && isTerminal(subagentCall), "the parent did not run the real subagent tool")
    await waitForOutcome(client, options, parent.id, "parent subagent turn")
    const children = await listChildren(instance.url, instance.password, parent.id, layout.projectA)
    assert(children.length === 1, `expected one direct child, got ${children.length}`)
    const child = children[0]!
    assert(child.parentID === parent.id, "the public host did not report the subagent child's parentID")
    await waitForOutcome(client, options, child.id, "child initial idle turn")
    ids = { ...ids, childSessionID: child.id }
    const running = instance
    if (running === undefined) throw new RunnerFailure("the host instance handle disappeared")
    const observe = () => snapshot(client, parent.id, child.id, running.url, running.password, layout.projectA)
    initialBaseline = await settleSnapshot(observe)
    assert(
      initialBaseline.parent.nativeHostReports >= 1 && initialBaseline.parent.invalidNativeReports === 0,
      "the initial host subagent report was not observed, or another synthetic existed before baseline",
    )
    evidence.push("real subagent child created; public host parentID matches")
    evidence.push("initial host subagent completion notice settled before baseline; not a plugin wake")

    const enrollBefore = initialBaseline
    const enrolled = await watch({
      operation: "enroll",
      sessionID: parent.id,
      requestId: "watch63-parent-1",
      goal: GOAL_TOKEN,
    })
    if (enrolled.task === null) throw new RunnerFailure(`parent enroll failed: ${enrolled.failure?.code ?? "unknown"}`)
    enrollBaseline = await observe()
    assertNoChange(enrollBefore, enrollBaseline, "parent enroll")
    const parentTaskID = enrolled.task.taskID
    ids = { ...ids, parentTaskID }
    evidence.push("parent task enrolled through the real watch RPC without a prompt")

    explicit.parent += 1
    const beginCall = await promptForResult(
      client,
      options,
      parent.id,
      `${PARENT_BEGIN_MARKER} taskID=${parentTaskID} version=${enrolled.task.version} reportId=watch63-parent-begin`,
    )
    assert(beginCall.name === "peers" && watchMeta(beginCall)?.["ok"] === true, "the parent begin tool report failed")
    beginBaseline = await settleSnapshot(observe)
    assert(beginBaseline.parent.user === (enrollBaseline?.parent.user ?? 0) + 1, "parent begin did not add exactly one explicit driver turn")
    assert(beginBaseline.child.user === (enrollBaseline?.child.user ?? 0), "parent begin woke the child")
    const parentShown = await watch({ operation: "show", sessionID: parent.id, taskID: parentTaskID })
    if (parentShown.task === null) throw new RunnerFailure("the parent task disappeared after begin")
    const grantBefore = beginBaseline
    const prepared = readDelegationGrant(
      await rpc("watchDelegation", {
        operation: "prepare",
        sessionID: parent.id,
        parentTaskID,
        expectedVersion: parentShown.task.version,
        targetSessionID: child.id,
        mode: "limited-correction",
        deployment: "single-host-same-location",
      }),
    )
    assert(prepared?.ok === true && prepared.challenge !== null, "controlled delegation prepare failed")
    const review = prepared.review
    assert(
      review !== undefined &&
        review.delegationTerms === terms.delegation &&
        review.correctionTerms === terms.correction &&
        review.deploymentRequired === true &&
        review.derivesCorrectionGrant === true,
      "delegation review did not carry the exact canonical texts and derived correction grant",
    )
    const challenge = prepared.challenge
    const confirmed = readDelegationGrant(
      await rpc("watchDelegation", {
        operation: "confirm",
        sessionID: parent.id,
        parentTaskID,
        expectedVersion: challenge.expectedVersion,
        generation: challenge.generation,
        targetSessionID: child.id,
        mode: challenge.mode,
        scopeDirectory: challenge.scopeDirectory,
        scopePeerScope: challenge.scopePeerScope,
        termsDigest: challenge.termsDigest,
        challenge: challenge.challenge,
        deployment: "single-host-same-location",
      }),
    )
    assert(confirmed?.ok === true && confirmed.grant?.state === "granted", "controlled delegation confirm failed")
    const grantViewRaw = await rpc("watchDelegationView", { sessionID: parent.id, parentTaskID })
    const grantView = readDelegationView(grantViewRaw)
    assert(grantView !== undefined && grantView.ok, "the parent delegation view was not readable after grant")
    grantBaseline = await observe()
    assertNoChange(grantBefore, grantBaseline, "grant prepare/confirm/view")
    evidence.push("controlled delegation grant prepared and confirmed; review texts exact")
    evidence.push("prepare, confirm and the read-only parent view added no prompt, generation or inbox item")

    baseline = grantBaseline
    const delegateShown = await watch({ operation: "show", sessionID: parent.id, taskID: parentTaskID })
    if (delegateShown.task === null) throw new RunnerFailure("the parent task disappeared before delegate")
    explicit.parent += 1
    const delegateCall = await promptForResult(
      client,
      options,
      parent.id,
      `${PARENT_DELEGATE_MARKER} taskID=${parentTaskID} version=${delegateShown.task.version} targetSessionID=${child.id} requestId=watch63-delegate-1 goal=${GOAL_TOKEN}`,
    )
    assert(delegateCall.name === "peers" && watchMeta(delegateCall)?.["ok"] === true, "the public delegate tool call failed")
    const delegatedTask = watchMeta(delegateCall)?.["task"] as { taskID?: string; version?: number } | null | undefined
    if (delegatedTask?.taskID === undefined || !Number.isSafeInteger(delegatedTask.version)) {
      throw new RunnerFailure("the delegate tool result carried no child task")
    }
    const childTaskID = delegatedTask.taskID
    const childTaskVersion = delegatedTask.version
    ids = { ...ids, childTaskID }
    afterDelegate = await settleSnapshot(observe)
    assertDelegateDeltas(baseline, afterDelegate)
    evidence.push("public delegate added only the explicit parent driver turn; child/inbox/queue unchanged")
    const settled = await settleSnapshot(observe)
    assertSameWakeFacts(afterDelegate, settled)
    assertNoInterrupted(afterDelegate)
    evidence.push("bounded settle after delegate produced no extra prompt, generation, steer or interrupt")

    explicit.child += 1
    const childBeginBefore = settled
    const childBegin = await promptForResult(
      client,
      options,
      child.id,
      `${CHILD_BEGIN_MARKER} taskID=${childTaskID} version=${childTaskVersion} reportId=watch63-child-begin`,
    )
    assert(childBegin.name === "peers" && watchMeta(childBegin)?.["ok"] === true, "the child begin tool report failed")
    const childBeginAfter = await settleSnapshot(observe)
    childBeginSnapshot = childBeginAfter
    assertChildBeginDriver(childBeginBefore, childBeginAfter)
    evidence.push("child begin produced one native host subagent report and one parent host-report response; no plugin prompt")

    const correctionText = await waitForCorrectionPrompt(client, child.id, 20_000)
    const correction = parseCorrectionCall(correctionText)
    if (correction === undefined) throw new RunnerFailure("the automatic correction prompt carried no concrete receipt")
    evidence.push("exactly one automatic correction prompt was queued to the child")

    if (scenario === "positive") {
      const receipt = await waitForCall(
        client,
        child.id,
        (call) => isTerminal(call) && call.name === "peers" && operationOf(call) === "receipt",
        60_000,
      )
      assert(receipt !== undefined, "the child never called receipt")
      assert(watchMeta(receipt)?.["continuePermit"] === true, "the child receipt did not issue one continue permit")
      const progress = await waitForCall(
        client,
        child.id,
        (call) =>
          isTerminal(call) &&
          call.name === "peers" &&
          operationOf(call) === "report" &&
          reportKindOf(call) === "progress",
        60_000,
      )
      assert(progress !== undefined, "the child never reported new progress")
      const recovered = await waitForRecovery(
        () => watch({ operation: "show", sessionID: child.id, taskID: childTaskID }),
        60_000,
      )
      assert(recovered, "the new progress did not produce recovery")

      explicit.child += 1
      await promptForResult(
        client,
        options,
        child.id,
        `${DUPLICATE_MARKER} taskID=${correction.taskID} attemptID=${correction.attemptID} correlation=${correction.correlation}`,
      )
      const duplicate = await waitForCall(
        client,
        child.id,
        (call) => isTerminal(call) && call.name === "peers" && operationOf(call) === "receipt" && watchMeta(call)?.["duplicate"] === true,
        60_000,
      )
      assert(duplicate !== undefined && watchMeta(duplicate)?.["continuePermit"] === false, "duplicate receipt issued another permit")
      explicit.parent += 1
      await promptForResult(
        client,
        options,
        parent.id,
        `${PARENT_RECEIPT_MARKER} taskID=${correction.taskID} attemptID=${correction.attemptID} correlation=${correction.correlation}`,
      )
      const parentReceipt = await waitForCall(
        client,
        parent.id,
        (call) => isTerminal(call) && call.name === "peers" && operationOf(call) === "receipt",
        60_000,
      )
      assert(parentReceipt !== undefined, "the parent never called receipt")
      assert(watchMeta(parentReceipt)?.["continuePermit"] === false, "the parent receipt received a permit")
      assert(
        (watchMeta(parentReceipt)?.["failure"] as { code?: string } | undefined)?.code === "E_WATCH_CALLER_MISMATCH",
        "the parent receipt was not refused as a wrong caller",
      )
      finalSnapshot = await settleSnapshot(observe)
      const finalSettled = await settleSnapshot(observe)
      assertSameWakeFacts(finalSnapshot, finalSettled)
      if (afterDelegate === undefined) throw new RunnerFailure("the delegate baseline disappeared")
      assertFinalDeltas(afterDelegate, finalSnapshot, scenario)
      assertNoInterrupted(finalSnapshot)
      const finalRaw = await rpc("watch", { operation: "show", sessionID: child.id, taskID: childTaskID })
      assert(!JSON.stringify(finalRaw).includes(correction.correlation), "the raw show answer leaked the dispatch correlation")
      const final = readWatchReply(finalRaw)
      if (final === undefined) throw new RunnerFailure("the final child show was not understood")
      if (final.task === null) throw new RunnerFailure("the child task disappeared")
      assert(final.task.attempts?.used === 1, "the child did not spend exactly one permanent attempt")
      assert(final.task.correction?.history?.[0]?.phase === "recovered", "the child attempt was not recovered")
      const childMessages = await client.context(child.id)
      const queued = childMessages.filter(
        (message) => message.type === "user" && messageText(message).includes(CORRECTION_PREFIX),
      )
      assert(queued.length === 1, `expected one correction queue prompt, got ${queued.length}`)
      const queueObserved = finalSnapshot.child.inboxCorrectionQueue > 0
      const steerObserved = finalSnapshot.child.inboxCorrectionSteer > 0
      assert(!steerObserved, "a correction steer item was observed")
      const nativeHostReportDelta = finalSnapshot.parent.nativeHostReports - (afterDelegate?.parent.nativeHostReports ?? 0)
      scenarioFacts = {
        permit: true,
        duplicate: true,
        parentReceiptRefused: true,
        recovered: true,
        attemptsUsed: 1,
        correctionPrompts: queued.length,
        nativeHostReportDelta,
        nativeHostReportSource: "host-subagent-completion",
        parentGeneratedByHostReports: nativeHostReportDelta > 0,
        watchPluginExtraPrompts: 0,
        queueEvidence: queueObserved ? "public-inbox-delivery-queue" : "entry-delivery-queue-only",
        queueObserved,
        steerObserved,
        parentDriverTurns: explicit.parent,
        childDriverTurns: explicit.child,
      }
      evidence.push("child receipt issued exactly one permit; duplicate and parent receipts were refused")
      evidence.push("the parent generated from the child's native host completion reports and the explicit wrong-caller driver; no plugin extra prompt")
      evidence.push("new progress and a new result reference produced recovery")
      evidence.push(
        queueObserved
          ? "the public inbox retained the correction with delivery=queue"
          : "one correction prompt observed; the inbox retained no consumed delivery, so queue remains entry-source evidence only",
      )
    } else {
      const state = await waitForStubWait(stub, 15_000)
      assert(state.waiting && !state.timedOut, "the stub did not reach its bounded correction latch")
      let refusalReason: string | null | undefined
      if (scenario === "revoke") {
        // The version was read before the delegate driver; no watch/view read
        // is performed while the receipt is latched.
        const revoked = readDelegationGrant(
          await rpc("watchDelegation", {
            operation: "revoke",
            sessionID: parent.id,
            parentTaskID,
            expectedVersion: delegateShown.task.version,
            targetSessionID: child.id,
          }),
        )
        assert(revoked?.ok === true && revoked.grant?.state === "revoked", "controlled delegation revoke failed")
        evidence.push("source delegation revoked before the child's first receipt")
      } else {
        const assigned = await rpc("setScope", { sessionID: child.id, scope: "watch63-other" })
        assert((assigned as { scope?: string } | undefined)?.scope === "watch63-other", "public setScope did not move the child")
        evidence.push("child scope changed through the public setScope RPC before the first receipt")
      }
      await releaseStub(stub)
      const receipt = await waitForCall(
        client,
        child.id,
        (call) => isTerminal(call) && call.name === "peers" && operationOf(call) === "receipt",
        60_000,
      )
      assert(receipt !== undefined, "the child never called receipt after release")
      const meta = watchMeta(receipt)
      assert(meta?.["seen"] === true, "the revoked/scope-changed receipt was not recorded as seen")
      assert(meta?.["duplicate"] === false, "the first receipt was reported as duplicate")
      assert(meta?.["continuePermit"] === false, "a permit was issued after revoke/scope change")
      refusalReason = typeof meta?.["refusalReason"] === "string" ? meta["refusalReason"] : null
      assert(typeof refusalReason === "string" && refusalReason.length > 0, "the refused receipt carried no reason")
      if (scenario === "revoke") assert(refusalReason.includes("delegation"), "the revoke refusal did not name delegation")
      const viewRaw = await rpc("watchDelegationView", { sessionID: parent.id, parentTaskID })
      const view = readDelegationView(viewRaw)
      assert(view !== undefined && view.ok, "the parent delegation view was not readable")
      const childView = view.children.find((entry) => entry.taskID === childTaskID)
      assert(childView !== undefined, "the delegated child was absent from the parent view")
      assert(
        childView.authorized === false && childView.task === null && childView.alerts === null,
        "a revoked/scope-changed child still exposed task or alert content",
      )
      assert(!JSON.stringify(viewRaw).includes(GOAL_TOKEN), "the delegation view leaked the parent goal")
      finalSnapshot = await settleSnapshot(observe)
      const finalSettled = await settleSnapshot(observe)
      assertSameWakeFacts(finalSnapshot, finalSettled)
      if (afterDelegate === undefined) throw new RunnerFailure("the delegate baseline disappeared")
      assertFinalDeltas(afterDelegate, finalSnapshot, scenario)
      assertNoInterrupted(finalSnapshot)
      const finalRaw = await rpc("watch", { operation: "show", sessionID: child.id, taskID: childTaskID })
      assert(!JSON.stringify(finalRaw).includes(correction.correlation), "the raw refused show leaked the dispatch correlation")
      const final = readWatchReply(finalRaw)
      if (final === undefined) throw new RunnerFailure("the final refused child show was not understood")
      assert(final.task !== null, "the child task disappeared before the final read")
      assert(final.task.attempts?.used === 1, "the refused round did not retain exactly one permanent attempt")
      const receiptView = final.task.correction?.history?.[0]?.receipt
      assert(
        receiptView !== undefined && receiptView !== null && receiptView.continuePermitIssuedAt === null,
        "the final view shows a permit",
      )
      const queueObserved = finalSnapshot.child.inboxCorrectionQueue > 0
      const steerObserved = finalSnapshot.child.inboxCorrectionSteer > 0
      assert(!steerObserved, "a correction steer item was observed")
      const nativeHostReportDelta = finalSnapshot.parent.nativeHostReports - (afterDelegate?.parent.nativeHostReports ?? 0)
      scenarioFacts = {
        scenario,
        permit: false,
        seen: true,
        duplicate: false,
        refusalReason,
        authorized: false,
        taskExposed: false,
        alertsExposed: false,
        attemptsUsed: final.task.attempts?.used ?? 0,
        nativeHostReportDelta,
        nativeHostReportSource: "host-subagent-completion",
        parentGeneratedByHostReports: nativeHostReportDelta > 0,
        watchPluginExtraPrompts: 0,
        queueEvidence: queueObserved ? "public-inbox-delivery-queue" : "entry-delivery-queue-only",
        queueObserved,
        steerObserved,
      }
      evidence.push("the fresh refusal recorded seen without a permit and the parent view redacted the child")
      evidence.push("the parent generated only from the child's native host completion reports; no plugin extra prompt")
      evidence.push(
        queueObserved
          ? "the public inbox retained the correction with delivery=queue"
          : "one correction prompt observed; the inbox retained no consumed delivery, so queue remains entry-source evidence only",
      )
    }
  } catch (error) {
    failure = safelyDescribe(error)
  } finally {
    let stop: { stopped: boolean; portClosed: boolean; observed: string } | undefined
    if (instance !== undefined) {
      try {
        stop = await instance.stop()
      } catch (error) {
        stop = { stopped: false, portClosed: false, observed: safelyDescribe(error) }
      }
    }
    let stubStopped = false
    let stubPortClosed = false
    if (stub !== undefined) {
      try {
        await stub.stop()
        stubStopped = true
        stubPortClosed = !(await isPortOpen(stub.port))
      } catch (error) {
        failure = failure ?? safelyDescribe(error)
      }
    }
    const afterRegistry = readLiveService(liveService)
    const isolation =
      stop?.stopped === true &&
      stop.portClosed === true &&
      stubStopped &&
      stubPortClosed &&
      beforeRegistry.digest === afterRegistry.digest
    const report = {
      ok: failure === undefined && isolation,
      failure: failure ?? null,
      scenario,
      runtime: runtime ?? null,
      ids,
      counts: {
        initial: initialBaseline ?? null,
        afterEnroll: enrollBaseline ?? null,
        afterBegin: beginBaseline ?? null,
        afterGrant: grantBaseline ?? null,
        afterChildBegin: childBeginSnapshot ?? null,
        beforeDelegate: baseline ?? null,
        afterDelegate: afterDelegate ?? null,
        final: finalSnapshot ?? null,
      },
      explicitDriverTurns: explicit,
      scenarioFacts,
      evidence,
      isolation: {
        stopped: stop?.stopped ?? null,
        portClosed: stop?.portClosed ?? null,
        stubPortClosed,
        liveServiceUntouched: beforeRegistry.digest === afterRegistry.digest,
        serviceJsonState: beforeRegistry.digest === MISSING ? "missing" : "present",
        childPid: instance?.pid ?? null,
        scratchRoot: layout.root,
        serverLog: layout.serverLog,
      },
      stub: stub?.state() ?? null,
    }
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
    if (report.ok && !keep) rmSync(layout.root, { recursive: true, force: true })
  }
}

async function reviewedTerms(pluginPath: string): Promise<{ readonly correction: string; readonly delegation: string }> {
  const domainPath = join(pluginPath, "src", "domain", "watch.ts")
  const delegationPath = join(pluginPath, "src", "watch", "delegation.ts")
  if (!existsSync(domainPath) || !existsSync(delegationPath)) {
    throw new RunnerFailure("the reviewed plugin source terms are unavailable at WATCH63_PLUGIN")
  }
  const domain = (await import(pathToFileURL(domainPath).href)) as Record<string, unknown>
  const delegation = (await import(pathToFileURL(delegationPath).href)) as Record<string, unknown>
  const correction = domain["WATCH_CORRECTION_TERMS"]
  const delegationTerms = delegation["WATCH_DELEGATION_TERMS"]
  if (typeof correction !== "string" || typeof delegationTerms !== "string") {
    throw new RunnerFailure("the reviewed plugin did not export its canonical terms")
  }
  return { correction, delegation: delegationTerms }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readWatchReply(value: unknown): WatchReply | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const ledger = readLedger(record["ledger"])
  const task = record["task"] === null ? null : readTask(record["task"])
  const enabled = record["enabled"]
  if (ledger === undefined || task === undefined || typeof enabled !== "boolean") return undefined
  const failure = record["failure"] === null ? null : asRecord(record["failure"])
  return {
    enabled,
    ledger,
    task,
    failure:
      failure === undefined || failure === null
        ? null
        : { ...(typeof failure["code"] === "string" ? { code: failure["code"] } : {}) },
  }
}

function readLedger(value: unknown): LedgerLite | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  if (typeof record["available"] !== "boolean") return undefined
  const stringOrNull = (key: string): string | null | undefined => {
    const field = record[key]
    return field === null || typeof field === "string" ? field : undefined
  }
  const numberOrNull = (key: string): number | null | undefined => {
    const field = record[key]
    return field === null || typeof field === "number" ? field : undefined
  }
  const appVersion = stringOrNull("appVersion")
  const platform = stringOrNull("platform")
  const arch = stringOrNull("arch")
  const sqliteVersion = stringOrNull("sqliteVersion")
  const journalMode = stringOrNull("journalMode")
  const synchronous = numberOrNull("synchronous")
  const busyTimeoutMs = numberOrNull("busyTimeoutMs")
  const reason = stringOrNull("reason")
  if (
    appVersion === undefined ||
    platform === undefined ||
    arch === undefined ||
    sqliteVersion === undefined ||
    journalMode === undefined ||
    synchronous === undefined ||
    busyTimeoutMs === undefined ||
    reason === undefined
  ) {
    return undefined
  }
  return {
    available: record["available"],
    reason,
    sqliteVersion,
    journalMode,
    synchronous,
    busyTimeoutMs,
    appVersion,
    platform,
    arch,
  }
}

function readTask(value: unknown): TaskLite | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const taskID = record["taskID"]
  const version = record["version"]
  if (typeof taskID !== "string" || typeof version !== "number" || !Number.isSafeInteger(version)) return undefined
  const attemptsRaw = asRecord(record["attempts"])
  const correctionRaw = asRecord(record["correction"])
  const historyRaw = correctionRaw?.["history"]
  const history = Array.isArray(historyRaw)
    ? historyRaw.map((item) => {
        const entry = asRecord(item)
        const receiptRaw = asRecord(entry?.["receipt"])
        return {
          ...(typeof entry?.["phase"] === "string" ? { phase: entry["phase"] } : {}),
          receipt:
            receiptRaw === undefined
              ? null
              : {
                  ...(typeof receiptRaw["continuePermitIssuedAt"] === "number" ||
                  receiptRaw["continuePermitIssuedAt"] === null
                    ? { continuePermitIssuedAt: receiptRaw["continuePermitIssuedAt"] }
                    : {}),
                },
        }
      })
    : undefined
  return {
    taskID,
    version,
    ...(attemptsRaw !== undefined && typeof attemptsRaw["used"] === "number"
      ? { attempts: { used: attemptsRaw["used"] } }
      : {}),
    ...(history === undefined ? {} : { correction: { history } }),
  }
}

function readDelegationGrant(value: unknown): DelegationGrantReply | undefined {
  const record = asRecord(value)
  if (record === undefined || typeof record["ok"] !== "boolean") return undefined
  const challengeRaw = asRecord(record["challenge"])
  const challenge =
    record["challenge"] === null
      ? null
      : challengeRaw === undefined
        ? undefined
        : readChallenge(challengeRaw)
  const grantRaw = asRecord(record["grant"])
  const reviewRaw = asRecord(record["review"])
  if (challenge === undefined) return undefined
  return {
    ok: record["ok"],
    challenge,
    grant:
      record["grant"] === null
        ? null
        : grantRaw === undefined
          ? null
          : { ...(typeof grantRaw["state"] === "string" ? { state: grantRaw["state"] } : {}) },
    ...(reviewRaw === undefined
      ? {}
      : {
          review: {
            delegationTerms: typeof reviewRaw["delegationTerms"] === "string" ? reviewRaw["delegationTerms"] : "",
            correctionTerms: typeof reviewRaw["correctionTerms"] === "string" ? reviewRaw["correctionTerms"] : "",
            deploymentRequired: reviewRaw["deploymentRequired"] === true,
            derivesCorrectionGrant: reviewRaw["derivesCorrectionGrant"] === true,
          },
        }),
  }
}

function readChallenge(record: Record<string, unknown>): ChallengeLite | undefined {
  const challenge = record["challenge"]
  const expectedVersion = record["expectedVersion"]
  const generation = record["generation"]
  const mode = record["mode"]
  const scopeDirectory = record["scopeDirectory"]
  const scopePeerScope = record["scopePeerScope"]
  const termsDigest = record["termsDigest"]
  if (
    typeof challenge !== "string" ||
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    typeof mode !== "string" ||
    typeof scopeDirectory !== "string" ||
    typeof scopePeerScope !== "string" ||
    typeof termsDigest !== "string"
  ) {
    return undefined
  }
  return { challenge, expectedVersion, generation, mode, scopeDirectory, scopePeerScope, termsDigest }
}

function readDelegationView(value: unknown): DelegationViewLite | undefined {
  const record = asRecord(value)
  if (record === undefined || typeof record["ok"] !== "boolean") return undefined
  const childrenRaw = record["children"]
  if (!Array.isArray(childrenRaw)) return undefined
  const children: DelegatedChildLite[] = []
  for (const item of childrenRaw) {
    const entry = asRecord(item)
    const taskID = entry?.["taskID"]
    const authorized = entry?.["authorized"]
    if (typeof taskID !== "string" || typeof authorized !== "boolean") return undefined
    children.push({
      taskID,
      authorized,
      task: entry?.["task"] ?? null,
      alerts: entry?.["alerts"] ?? null,
    })
  }
  return { ok: record["ok"], children }
}

function requiredAbsolutePath(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new RunnerFailure(`${name} is required`)
  if (!isAbsolute(value)) throw new RunnerFailure(`${name} must be absolute`)
  if (!existsSync(value)) throw new RunnerFailure(`${name} does not exist`)
  return value
}

class RunnerFailure extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RunnerFailure(message)
}

function safelyDescribe(error: unknown): string {
  if (error instanceof RunnerFailure) return error.message
  if (error instanceof Error) {
    const name = error.name
    return name === "Error" ? "request failed" : name
  }
  return "request failed"
}

async function listChildren(
  baseUrl: string,
  password: string,
  parentID: string,
  directory: string,
): Promise<RawSession[]> {
  const rows = await apiData<RawSession[]>(baseUrl, password, `/api/session?parentID=${encodeURIComponent(parentID)}`, directory)
  return rows.filter((row) => row.parentID === parentID)
}

async function getSessionInfo(
  baseUrl: string,
  password: string,
  sessionID: string,
  directory: string,
): Promise<RawSession> {
  return apiData<RawSession>(baseUrl, password, `/api/session/${encodeURIComponent(sessionID)}`, directory)
}

async function listInbox(
  baseUrl: string,
  password: string,
  sessionID: string,
  directory: string,
): Promise<RawInbox[]> {
  return apiData<RawInbox[]>(baseUrl, password, `/api/session/${encodeURIComponent(sessionID)}/inbox`, directory)
}

async function apiData<T>(
  baseUrl: string,
  password: string,
  path: string,
  directory: string,
): Promise<T> {
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization, "x-opencode-directory": directory },
  })
  const text = await response.text()
  if (!response.ok) throw new RunnerFailure(`public API ${path.split("?")[0]} answered ${response.status}`)
  return (JSON.parse(text) as { data: T }).data
}

async function countOne(
  client: ReturnType<typeof createClient>,
  sessionID: string,
  baseUrl: string,
  password: string,
  directory: string,
  expectedChildID: string | null,
): Promise<Counts> {
  const messages = (await client.context(sessionID)) as MetadataMessage[]
  const counted = countMessages(messages.map((message) => ({ type: message.type, text: messageText(message as SessionMessage) })))
  const native = countNativeSubagentReports(messages, expectedChildID)
  const inbox = await listInbox(baseUrl, password, sessionID, directory)
  const info = await getSessionInfo(baseUrl, password, sessionID, directory)
  const correctionInbox = inbox.filter(
    (item) => typeof item.payload?.text === "string" && item.payload.text.includes(CORRECTION_PREFIX),
  )
  return {
    user: counted.user,
    assistant: counted.assistant,
    correction: counted.correctionUsers,
    synthetic: counted.synthetic,
    nativeHostReports: native.nativeHostReports,
    otherSynthetic: native.otherSynthetic,
    invalidNativeReports: native.invalidNativeReports,
    inbox: inbox.length,
    inboxQueue: inbox.filter((item) => item.delivery === "queue").length,
    inboxSteer: inbox.filter((item) => item.delivery === "steer").length,
    inboxCorrectionQueue: correctionInbox.filter((item) => item.delivery === "queue").length,
    inboxCorrectionSteer: correctionInbox.filter((item) => item.delivery === "steer").length,
    outcome: info.outcome ?? null,
  }
}

async function snapshot(
  client: ReturnType<typeof createClient>,
  parentID: string,
  childID: string,
  baseUrl: string,
  password: string,
  directory: string,
): Promise<Snapshot> {
  return {
    parent: await countOne(client, parentID, baseUrl, password, directory, childID),
    child: await countOne(client, childID, baseUrl, password, directory, null),
  }
}

function assertDelegateDeltas(before: Snapshot, after: Snapshot): void {
  assert(after.parent.user === before.parent.user + 1, "delegate added more than the explicit parent driver user message")
  assert(after.parent.assistant >= before.parent.assistant, "delegate lost a parent assistant message")
  assert(after.child.user === before.child.user, "delegate woke the child with a user message")
  assert(after.child.assistant === before.child.assistant, "delegate generated in the child")
  assert(after.parent.synthetic === before.parent.synthetic, "delegate added a parent synthetic message")
  assert(after.child.synthetic === before.child.synthetic, "delegate added a child synthetic message")
  assert(
    after.parent.nativeHostReports === before.parent.nativeHostReports,
    "delegate added a parent native subagent report",
  )
  assert(after.parent.otherSynthetic === before.parent.otherSynthetic, "delegate added another parent synthetic message")
  assert(after.parent.invalidNativeReports === before.parent.invalidNativeReports, "delegate added an invalid parent report")
  assert(
    after.child.nativeHostReports === before.child.nativeHostReports,
    "delegate added a child native subagent report",
  )
  assert(after.child.otherSynthetic === before.child.otherSynthetic, "delegate added another child synthetic message")
  assert(after.child.invalidNativeReports === before.child.invalidNativeReports, "delegate added an invalid child report")
  assert(after.parent.correction === before.parent.correction, "delegate queued a parent correction prompt")
  assert(after.child.correction === before.child.correction, "delegate queued a child correction prompt")
  assert(after.parent.inbox === before.parent.inbox, "delegate changed the parent inbox")
  assert(after.child.inbox === before.child.inbox, "delegate changed the child inbox")
  assert(after.parent.inboxSteer === 0 && after.child.inboxSteer === 0, "delegate put a steer item in an inbox")
}

function sameCounts(left: Counts, right: Counts): boolean {
  return (
    left.user === right.user &&
    left.assistant === right.assistant &&
    left.correction === right.correction &&
    left.synthetic === right.synthetic &&
    left.nativeHostReports === right.nativeHostReports &&
    left.otherSynthetic === right.otherSynthetic &&
    left.invalidNativeReports === right.invalidNativeReports &&
    left.inbox === right.inbox &&
    left.inboxQueue === right.inboxQueue &&
    left.inboxSteer === right.inboxSteer &&
    left.inboxCorrectionQueue === right.inboxCorrectionQueue &&
    left.inboxCorrectionSteer === right.inboxCorrectionSteer &&
    left.outcome === right.outcome
  )
}

function sameSnapshot(left: Snapshot, right: Snapshot): boolean {
  return sameCounts(left.parent, right.parent) && sameCounts(left.child, right.child)
}

async function settleSnapshot(observe: () => Promise<Snapshot>): Promise<Snapshot> {
  const deadline = Date.now() + 20_000
  let last = await observe()
  let stable = 0
  while (Date.now() < deadline) {
    await sleep(500)
    const next = await observe()
    if (sameSnapshot(last, next)) stable += 1
    else stable = 0
    last = next
    if (stable >= 2) return last
  }
  throw new RunnerFailure("the parent/child wake counts did not settle")
}

function assertNoChange(before: Snapshot, after: Snapshot, phase: string): void {
  assert(sameSnapshot(before, after), `${phase} changed a user, assistant, correction or inbox count`)
}

function assertSameWakeFacts(after: Snapshot, settled: Snapshot): void {
  assert(sameSnapshot(after, settled), "session wake counts kept growing after the driver turn")
}

function assertNoInterrupted(snapshot: Snapshot): void {
  assert(snapshot.parent.outcome !== "interrupted" && snapshot.child.outcome !== "interrupted", "a session was interrupted")
  assert(snapshot.child.inboxCorrectionSteer === 0, "a correction steer item appeared in the child inbox")
}

function assertFinalDeltas(afterDelegate: Snapshot, final: Snapshot, scenario: Scenario): void {
  const parentUserDelta = final.parent.user - afterDelegate.parent.user
  const parentAssistantDelta = final.parent.assistant - afterDelegate.parent.assistant
  const childUserDelta = final.child.user - afterDelegate.child.user
  const childAssistantDelta = final.child.assistant - afterDelegate.child.assistant
  const nativeDelta = final.parent.nativeHostReports - afterDelegate.parent.nativeHostReports
  const expectedParentUser = scenario === "positive" ? 1 : 0
  const expectedChildUser = scenario === "positive" ? 3 : 2
  const expectedNativeReports = scenario === "positive" ? 3 : 2
  assert(parentUserDelta === expectedParentUser, "the parent user count added an unexpected explicit or automatic turn")
  assert(final.parent.correction === afterDelegate.parent.correction, "the parent gained a correction prompt")
  assert(childUserDelta === expectedChildUser, "the child user count did not match its explicit drivers plus one correction")
  assert(final.child.correction === afterDelegate.child.correction + 1, "the child did not get exactly one correction prompt")
  assert(nativeDelta === expectedNativeReports, "the host native subagent report count did not match the child's turns")
  assert(final.parent.otherSynthetic === afterDelegate.parent.otherSynthetic, "the parent gained another synthetic message")
  assert(final.parent.invalidNativeReports === 0, "the parent had an invalid native report")
  assert(final.child.nativeHostReports === afterDelegate.child.nativeHostReports, "the child gained a native report")
  assert(final.child.otherSynthetic === afterDelegate.child.otherSynthetic, "the child gained another synthetic message")
  assert(final.child.invalidNativeReports === 0, "the child had an invalid native report")
  assert(
    parentAssistantDelta >= nativeDelta && parentAssistantDelta <= nativeDelta + (scenario === "positive" ? 2 : 0),
    "the parent assistant count moved outside one response per host report plus its explicit driver",
  )
  assert(childAssistantDelta >= 1, "the child assistant did not run its explicit/correction turns")
  assert(final.parent.inboxCorrectionSteer === 0, "a correction steer item appeared in the parent inbox")
  assert(final.child.inboxCorrectionSteer === 0, "a correction steer item appeared in the child inbox")
}

function assertChildBeginDriver(before: Snapshot, after: Snapshot): void {
  assert(after.parent.user === before.parent.user, "the child begin driver added a parent user message")
  assert(after.parent.assistant === before.parent.assistant + 1, "the child begin driver did not produce one parent host-report response")
  assert(after.parent.correction === before.parent.correction, "the child begin driver queued a parent correction")
  assert(
    after.parent.nativeHostReports === before.parent.nativeHostReports + 1,
    "the child begin driver did not produce exactly one native subagent report",
  )
  assert(after.parent.otherSynthetic === before.parent.otherSynthetic, "the child begin driver added another synthetic message")
  assert(after.parent.invalidNativeReports === 0, "the child begin driver produced an invalid native report")
  assert(after.parent.inboxCorrectionSteer === 0, "the child begin driver queued a correction steer item")
  assert(after.child.user === before.child.user + 1, "the child begin driver did not add exactly one explicit turn")
  assert(after.child.nativeHostReports === before.child.nativeHostReports, "the child gained a native report")
  assert(after.child.otherSynthetic === before.child.otherSynthetic, "the child gained another synthetic message")
  assert(after.child.invalidNativeReports === 0, "the child had an invalid native report")
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
      (message) => message.type === "user" && messageText(message).includes(CORRECTION_PREFIX),
    )
    if (found !== undefined) return messageText(found)
    await sleep(POLL_MS)
  }
  throw new RunnerFailure("the automatic correction prompt never appeared")
}

async function waitForRecovery(
  show: () => Promise<WatchReply>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const payload = await show()
    if (payload.task?.correction?.history?.[0]?.phase === "recovered") return true
    await sleep(POLL_MS)
  }
  return false
}

async function waitForStubWait(
  stub: Watch63StubHandle,
  timeoutMs: number,
): Promise<{ readonly waiting: boolean; readonly timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(`${stub.controlUrl}/state`)
    const state = (await response.json()) as { waiting?: boolean; timedOut?: boolean }
    if (state.waiting === true || state.timedOut === true) {
      return { waiting: state.waiting === true, timedOut: state.timedOut === true }
    }
    await sleep(100)
  }
  throw new RunnerFailure("the stub correction latch did not become ready")
}

async function releaseStub(stub: Watch63StubHandle): Promise<void> {
  const response = await fetch(`${stub.controlUrl}/release`, { method: "POST" })
  if (!response.ok) throw new RunnerFailure("the stub control release failed")
}

function watchMeta(call: ToolCall): Record<string, unknown> | undefined {
  const meta = call.metadata["watch"]
  return typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : undefined
}

function operationOf(call: ToolCall): string | undefined {
  const input = call.input
  if (typeof input !== "object" || input === null) return undefined
  const watch = (input as { watch?: unknown }).watch
  if (typeof watch !== "object" || watch === null) return undefined
  const operation = (watch as { operation?: unknown }).operation
  return typeof operation === "string" ? operation : undefined
}

function reportKindOf(call: ToolCall): string | undefined {
  const input = call.input
  if (typeof input !== "object" || input === null) return undefined
  const watch = (input as { watch?: unknown }).watch
  if (typeof watch !== "object" || watch === null) return undefined
  const kind = (watch as { kind?: unknown }).kind
  return typeof kind === "string" ? kind : undefined
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ ok: false, failure: safelyDescribe(error) }))
    process.exitCode = 1
  })
}
