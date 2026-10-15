/**
 * `bun run harness` itself: the exit contract a caller depends on.
 *
 * These runs never boot an instance — a missing plugin directory fails before
 * anything is started — so they are safe for CI, which has no opencode binary.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { REPO_ROOT } from "../scripts/harness/paths.ts"

const ENTRYPOINT = join(REPO_ROOT, "scripts", "harness.ts")

function harness(args: readonly string[]) {
  return spawnSync("bun", [ENTRYPOINT, ...args], { cwd: REPO_ROOT, encoding: "utf8" })
}

describe("harness exit contract", () => {
  test("--help prints the usage and exits zero", () => {
    const result = harness(["--help"])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Usage: bun run harness [options]")
    expect(result.stdout).toContain("--no-model                The structural pass, stated explicitly (the default)")
  })

  test("a usage error exits two and explains itself", () => {
    const result = harness(["--not-a-flag"])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("unknown argument")
  })

  test("an unmet expectation exits non-zero and the report names it", () => {
    // No mode flag: the default pass is the one that has to answer for this.
    const result = harness(["--plugin", join(REPO_ROOT, "does-not-exist"), "--json"])
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout) as {
      ok: boolean
      expectations: Array<{ name: string; met: boolean; observed: string }>
    }
    expect(report.ok).toBe(false)
    const failed = report.expectations.filter((expectation) => !expectation.met)
    expect(failed.map((expectation) => expectation.name)).toContain("plugin-path")
    expect(failed[0]!.observed).toContain("does-not-exist")
  })
})
