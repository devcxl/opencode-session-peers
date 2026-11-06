/** Offline two-server experiment. Requires an explicit scratch parent directory. */
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { createClient } from "./client.ts"
import { isPortOpen, prepareScratch, sleep, startInstance, type InstanceHandle } from "./instance.ts"
import { REPO_ROOT, STUB_MODEL_ID, STUB_PROVIDER_ID, scratchLayout } from "./paths.ts"
import { startStubModel, type StubHandle } from "./stub/model-server.ts"
import { askPrompt, LIST_PROMPT, STUB_REPLY_DIRECTIVE } from "./stub/model-server.ts"
import { promptForResult } from "./stub/transcript.ts"
import { messageText } from "./sessions.ts"
import type { HarnessOptions } from "./args.ts"

interface ProbeRecord { pid: number; sessionID: string; action: string }

async function main(): Promise<void> {
  const parent = process.argv[2]
  if (parent === undefined) throw new Error("Provide an explicit scratch parent directory")
  const root = mkdtempSync(join(resolve(parent), "session-peers-cross-"))
  const layout = scratchLayout(root, "run")
  const probeLog = join(root, "tool-processes.jsonl")
  const servers: InstanceHandle[] = []
  let stub: StubHandle | undefined
  try {
    stub = await startStubModel()
    prepareScratch(layout, {
      plugins: [
        { package: REPO_ROOT, options: { askTimeoutMs: 20_000 } },
        join(REPO_ROOT, "scripts/harness/process-probe"),
      ],
      stub: true,
    })
    const env = { ...process.env, SESSION_PEERS_PROCESS_PROBE_LOG: probeLog }
    for (const name of ["a", "b"]) {
      servers.push(await startInstance({
        layout: { ...layout, serverLog: join(root, `server-${name}.log`) },
        password: randomUUID(),
        opencodeBin: process.env["OPENCODE_BIN"] ?? "/usr/bin/opencode",
        bootTimeoutMs: 60_000,
        stubBaseUrl: `${stub.url}/v1`,
        env,
      }))
    }
    const [serverA, serverB] = servers as [InstanceHandle, InstanceHandle]
    const a = createClient(serverA.url, serverA.password)
    const b = createClient(serverB.url, serverB.password)
    await a.models(layout.projectA)
    await b.models(layout.projectB)
    const model = { providerID: STUB_PROVIDER_ID, id: STUB_MODEL_ID }
    const sessionA = await a.createSession({ directory: layout.projectA, title: "cross-a", model })
    const sessionB = await b.createSession({ directory: layout.projectB, title: "cross-b", model })
    const options = { turnTimeoutMs: 30_000 } as HarnessOptions
    await promptForResult(a, options, sessionA.id, LIST_PROMPT)
    await promptForResult(b, options, sessionB.id, LIST_PROMPT)
    const asking = promptForResult(a, options, sessionA.id, askPrompt("cross-b", "HARNESS_CROSS_QUESTION"))
      .then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) {
      const messages = await b.context(sessionB.id)
      if (messages.some((message) => message.type === "user" && messageText(message).includes("HARNESS_CROSS_QUESTION"))) break
      await sleep(100)
    }
    const replyResult = await promptForResult(b, options, sessionB.id, STUB_REPLY_DIRECTIVE)
    if (replyResult.metadata["outcome"] !== "stored") throw new Error(`reply was not stored: ${replyResult.text}`)
    const answer = await asking
    if (!answer.ok) throw answer.error
    const result = answer.value
    if (result.metadata["answered"] !== true) throw new Error(`ask did not return an answer: ${result.text}`)
    const records = readFileSync(probeLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ProbeRecord)
    const ask = records.find((record) => record.sessionID === sessionA.id && record.action === "ask")
    const reply = records.find((record) => record.sessionID === sessionB.id && record.action === "reply")
    if (ask === undefined || reply === undefined) throw new Error("missing ask/reply process provenance")
    console.log(`ask server pid=${ask.pid}; reply server pid=${reply.pid}; distinct=${ask.pid !== reply.pid}`)
    console.log(`ask returned: ${result.text}`)
    if (ask.pid === reply.pid) throw new Error("the host ran both tool calls in the same server process")
    const stopped = await serverB.stop()
    if (!stopped.stopped || !stopped.portClosed) throw new Error(`second server did not stop: ${stopped.observed}`)
    servers.pop()
    let unavailable = false
    try {
      await b.listSessions()
    } catch {
      unavailable = true
    }
    if (!unavailable) throw new Error("the stopped server still answered")
    await a.listSessions()
    console.log("second server unavailable after shutdown; first server still answers")
  } finally {
    const failures: string[] = []
    for (const server of servers.reverse()) {
      try {
        const outcome = await server.stop()
        if (!outcome.stopped || !outcome.portClosed) failures.push(outcome.observed)
      } catch (error) {
        failures.push(`server ${server.pid}: ${String(error)}`)
      }
    }
    if (stub !== undefined) {
      try {
        await stub.stop()
        if (await isPortOpen(stub.port)) failures.push(`stub port ${stub.port} remains open`)
      } catch (error) {
        failures.push(`stub: ${String(error)}`)
      }
    }
    if (failures.length === 0) rmSync(root, { recursive: true, force: true })
    else throw new Error(`Cleanup failed; scratch retained at ${root}: ${failures.join("; ")}`)
  }
}

await main()
