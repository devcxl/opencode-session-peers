/**
 * Path decisions, without booting anything: what lives where, how a plugin
 * directory is recognised, and which developer paths the harness is allowed to
 * read (and never write).
 */

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  PROBE_LOG_ENV,
  PROBE_PLUGIN_DIR,
  REPO_ROOT,
  authJsonPath,
  developerDataDir,
  developerStateDir,
  globalConfigText,
  pluginEntrypoint,
  projectConfigText,
  resolvePluginPath,
  scratchLayout,
  serviceJsonPath,
} from "../scripts/harness/paths.ts"

const WORK = mkdtempSync(join(tmpdir(), "session-peers-paths-"))
afterAll(() => rmSync(WORK, { recursive: true, force: true }))

describe("scratch layout", () => {
  const layout = scratchLayout("/scratch", "abc-123")

  test("everything the instance owns lives under one scratch root", () => {
    expect(layout.root).toBe(join("/scratch", "session-peers-harness-abc-123"))
    for (const path of [layout.data, layout.state, layout.cache, layout.config, layout.projectA, layout.projectB]) {
      expect(path.startsWith(`${layout.root}/`), path).toBe(true)
    }
  })

  test("the database and the copied credentials live in the instance data dir", () => {
    expect(layout.database).toBe(join(layout.data, "opencode", "opencode.db"))
    expect(layout.authFile).toBe(join(layout.data, "opencode", "auth.json"))
  })

  test("the two projects are different directories", () => {
    expect(layout.projectA).not.toBe(layout.projectB)
  })

  test("the probe log and server log are inside the scratch root", () => {
    expect(layout.probeLog.startsWith(`${layout.root}/`)).toBe(true)
    expect(layout.serverLog.startsWith(`${layout.root}/`)).toBe(true)
  })

  test("the stub provider lives in the instance's own config directory", () => {
    expect(layout.stubProvider.startsWith(`${layout.config}/`)).toBe(true)
    expect(layout.stubProvider.endsWith("harness-stub-provider.ts")).toBe(true)
  })
})

describe("plugin paths", () => {
  test("relative plugin paths resolve against the working directory", () => {
    expect(resolvePluginPath("./plug", "/work")).toBe("/work/plug")
    expect(resolvePluginPath("/abs/plug", "/work")).toBe("/abs/plug")
  })

  test("a directory with an entrypoint is recognised, an empty one is not", () => {
    const withIndex = join(WORK, "with-index")
    const withServer = join(WORK, "with-server")
    const empty = join(WORK, "empty")
    mkdirSync(withIndex)
    mkdirSync(withServer)
    mkdirSync(empty)
    writeFileSync(join(withIndex, "index.ts"), "export default {}\n")
    writeFileSync(join(withServer, "server.ts"), "export default {}\n")

    expect(pluginEntrypoint(withIndex)).toBe(join(withIndex, "index.ts"))
    expect(pluginEntrypoint(withServer)).toBe(join(withServer, "server.ts"))
    expect(pluginEntrypoint(empty)).toBeUndefined()
  })

  test("this repository is the default plugin and the probe fixture exists", () => {
    expect(existsSync(join(REPO_ROOT, "package.json"))).toBe(true)
    expect(pluginEntrypoint(PROBE_PLUGIN_DIR)).toBe(join(PROBE_PLUGIN_DIR, "index.ts"))
  })

  test("the probe environment variable has one name", () => {
    expect(PROBE_LOG_ENV).toBe("SESSION_PEERS_HARNESS_PROBE_LOG")
  })
})

describe("project config", () => {
  test("declares every plugin directory and disables sharing", () => {
    const parsed = JSON.parse(projectConfigText(["/plugin/one", "/plugin/two"])) as {
      share: string
      plugins: string[]
    }
    expect(parsed.plugins).toEqual(["/plugin/one", "/plugin/two"])
    expect(parsed.share).toBe("disabled")
  })

  test("the instance config disables sharing and updates", () => {
    const parsed = JSON.parse(globalConfigText()) as { share: string; update: string }
    expect(parsed.share).toBe("disabled")
    expect(parsed.update).toBe("disable")
  })
})

describe("developer paths", () => {
  test("XDG overrides are respected, defaults are the usual ones", () => {
    expect(developerDataDir({ XDG_DATA_HOME: "/xdg/data" })).toBe(resolve("/xdg/data/opencode"))
    expect(developerStateDir({ XDG_STATE_HOME: "/xdg/state" })).toBe(resolve("/xdg/state/opencode"))
    expect(developerDataDir({})).toMatch(/\/\.local\/share\/opencode$/)
    expect(developerStateDir({})).toMatch(/\/\.local\/state\/opencode$/)
  })

  test("the harness reads exactly two files from the live setup", () => {
    expect(authJsonPath({ XDG_DATA_HOME: "/xdg/data" })).toBe(resolve("/xdg/data/opencode/auth.json"))
    expect(serviceJsonPath({ XDG_STATE_HOME: "/xdg/state" })).toBe(resolve("/xdg/state/opencode/service.json"))
  })
})
