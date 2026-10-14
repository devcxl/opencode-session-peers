/**
 * The evidence helpers. The isolation promise rests on `digestFile` and
 * `readLiveService`, and the plugin-load check rests on parsing the server log,
 * so both are pinned down here with fixtures instead of trusting the run.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MISSING, digestFile, isProcessAlive, readLiveService } from "../scripts/harness/isolation.ts"
import { loadedPluginIds, logTail } from "../scripts/harness/instance.ts"

const WORK = mkdtempSync(join(tmpdir(), "session-peers-isolation-"))
afterAll(() => rmSync(WORK, { recursive: true, force: true }))

describe("digestFile", () => {
  test("hashes file contents the way md5sum does", () => {
    const path = join(WORK, "credentials.json")
    writeFileSync(path, '{"password":"do-not-print-me"}')
    const expected = createHash("md5").update('{"password":"do-not-print-me"}').digest("hex")
    expect(digestFile(path)).toBe(expected)
  })

  test("a missing file is reported as missing, not as an error", () => {
    expect(digestFile(join(WORK, "nope.json"))).toBe(MISSING)
  })
})

describe("readLiveService", () => {
  test("reads the registry without keeping the password", () => {
    const path = join(WORK, "service.json")
    writeFileSync(path, JSON.stringify({ id: "x", url: "http://127.0.0.1:49374", pid: 3793275, password: "secret" }))
    const service = readLiveService(path)
    expect(service.digest).toBe(createHash("md5").update(JSON.stringify({ id: "x", url: "http://127.0.0.1:49374", pid: 3793275, password: "secret" })).digest("hex"))
    expect(service.pid).toBe(3793275)
    expect(service.url).toBe("http://127.0.0.1:49374")
    expect(JSON.stringify(service)).not.toContain("secret")
  })

  test("an unparseable registry still produces a digest", () => {
    const path = join(WORK, "broken.json")
    writeFileSync(path, "{not json")
    const service = readLiveService(path)
    expect(service.digest).not.toBe(MISSING)
    expect(service.pid).toBeUndefined()
  })

  test("no live service at all is a missing digest", () => {
    expect(readLiveService(join(WORK, "absent.json"))).toEqual({ digest: MISSING })
  })

  test("this process is alive, an impossible pid is not", () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(2_147_483_646)).toBe(false)
  })
})

describe("server log parsing", () => {
  const log = [
    'timestamp=2026-10-14T12:49:54.690Z level=INFO run=f15e9d09 msg="loading plugin" id=/scratch/plugin entrypoint=file:///scratch/plugin/index.ts http.span=42 role=server',
    "server listening on http://127.0.0.1:42641",
    'timestamp=2026-10-14T12:49:55.690Z level=INFO run=f15e9d09 msg="loading plugin" id=/scratch/plugin entrypoint=file:///scratch/plugin/index.ts http.span=43 role=server',
    'timestamp=2026-10-14T12:49:56.690Z level=INFO run=f15e9d09 msg="loading plugin" id=/scratch/probe entrypoint=file:///scratch/probe/index.ts http.span=44 role=server',
  ].join("\n")

  test("collects each loaded plugin once", () => {
    expect(loadedPluginIds(log)).toEqual(["/scratch/plugin", "/scratch/probe"])
  })

  test("a log without load records yields nothing", () => {
    expect(loadedPluginIds("server listening on http://127.0.0.1:1")).toEqual([])
  })

  test("log tails are bounded and never empty", () => {
    expect(logTail(log, 1)).toBe(log.split("\n").at(-1)!)
    expect(logTail("", 5)).toBe("(no server output)")
  })
})
