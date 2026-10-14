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
import { instanceEnvironment, loadedPluginIds, logTail } from "../scripts/harness/instance.ts"
import { readProbeLog } from "../scripts/harness/checks.ts"
import { PROBE_LOG_ENV, scratchLayout } from "../scripts/harness/paths.ts"

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

describe("instance environment", () => {
  const layout = scratchLayout("/scratch-root", "env-test")

  test("the instance's own directories are the scratch ones", () => {
    const env = instanceEnvironment(layout, "harness-pw", { PATH: "/usr/bin" })
    expect(env["XDG_DATA_HOME"]).toBe(layout.data)
    expect(env["XDG_STATE_HOME"]).toBe(layout.state)
    expect(env["XDG_CACHE_HOME"]).toBe(layout.cache)
    expect(env["XDG_CONFIG_HOME"]).toBe(layout.config)
    expect(env[PROBE_LOG_ENV]).toBe(layout.probeLog)
  })

  test("the instance cannot inherit the host's opencode identity", () => {
    const env = instanceEnvironment(layout, "harness-pw", {
      PATH: "/usr/bin",
      HOME: "/home/developer",
      OPENCODE_SERVER_PASSWORD: "the-live-service-password",
      OPENCODE_PASSWORD: "the-live-service-password",
      OPENCODE_DB: "/home/developer/.local/share/opencode/opencode.db",
      OPENCODE_CONFIG_DIR: "/home/developer/.config/opencode",
      OPENCODE_SESSION_ID: "ses_of_the_calling_session",
    })
    expect(env["OPENCODE_SERVER_PASSWORD"]).toBe("harness-pw")
    expect(env["OPENCODE_PASSWORD"]).toBeUndefined()
    expect(env["OPENCODE_DB"]).toBeUndefined()
    expect(env["OPENCODE_CONFIG_DIR"]).toBeUndefined()
    expect(env["OPENCODE_SESSION_ID"]).toBeUndefined()
    expect(env["PATH"]).toBe("/usr/bin")
    expect(env["HOME"]).toBe("/home/developer")
  })

  test("the developer's XDG directories never reach the instance", () => {
    const env = instanceEnvironment(layout, "harness-pw", {
      XDG_DATA_HOME: "/home/developer/.local/share",
      XDG_STATE_HOME: "/home/developer/.local/state",
      XDG_CONFIG_HOME: "/home/developer/.config",
    })
    expect(env["XDG_DATA_HOME"]).toBe(layout.data)
    expect(env["XDG_STATE_HOME"]).toBe(layout.state)
    expect(env["XDG_CONFIG_HOME"]).toBe(layout.config)
    const inDeveloperDirs = Object.values(env).some(
      (value) => value !== undefined && (value.startsWith("/home/developer/.local") || value.startsWith("/home/developer/.config")),
    )
    expect(inDeveloperDirs).toBe(false)
  })
})

describe("probe log evidence", () => {
  test("every recorded setup is one line of evidence", () => {
    const path = join(WORK, "plugin-loads.jsonl")
    writeFileSync(path, '{"pid":11,"directory":"/scratch/project-a","version":"2.0.29"}\n\n{"pid":11,"directory":"/scratch/project-b","version":"2.0.29"}\n')
    expect(readProbeLog(path)).toEqual([
      { pid: 11, directory: "/scratch/project-a", version: "2.0.29" },
      { pid: 11, directory: "/scratch/project-b", version: "2.0.29" },
    ])
  })

  test("no probe log means no evidence, not an error", () => {
    expect(readProbeLog(join(WORK, "no-such-probe.jsonl"))).toEqual([])
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
