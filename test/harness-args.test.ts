/**
 * Argument parsing: defaults, overrides, and every rejection. No instance is
 * booted here, so these are the cheapest checks the harness has.
 */

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { UsageError, modelLabel, parseArgs, scratchId, wantsHelp } from "../scripts/harness/args.ts"
import { REPO_ROOT, defaultScratchRoot } from "../scripts/harness/paths.ts"

const CWD = "/tmp/harness-cwd"

describe("harness arguments", () => {
  test("defaults: this repository, the structural pass, scratch under the tmp dir", () => {
    const options = parseArgs([], CWD)
    expect(options.pluginPath).toBe(REPO_ROOT)
    expect(options.model).toBeUndefined()
    expect(options.driveModel).toBe(false)
    expect(options.stub).toBe(false)
    expect(options.turnTimeoutMs).toBeGreaterThan(0)
    expect(options.bootTimeoutMs).toBeGreaterThan(0)
    expect(options.scratchRoot).toBe(defaultScratchRoot())
    expect(options.keep).toBe(false)
    expect(options.json).toBe(false)
  })

  test("--plugin resolves relative to the working directory", () => {
    expect(parseArgs(["--plugin", "fixtures/plugin"], CWD).pluginPath).toBe("/tmp/harness-cwd/fixtures/plugin")
    expect(parseArgs(["--plugin", "/abs/plugin"], CWD).pluginPath).toBe("/abs/plugin")
  })

  test("--model splits provider and model id, keeping later slashes, and opts into driving", () => {
    const options = parseArgs(["--model", "half-cabbage/deepseek-v4.1-flash"], CWD)
    expect(options.model).toEqual({ providerID: "half-cabbage", id: "deepseek-v4.1-flash" })
    expect(options.driveModel).toBe(true)
    expect(parseArgs(["--model", "opencode/vendor/name"], CWD).model).toEqual({
      providerID: "opencode",
      id: "vendor/name",
    })
    expect(modelLabel({ providerID: "openai", id: "gpt-6-luna" })).toBe("openai/gpt-6-luna")
  })

  test("--no-model states the structural pass, which is the default", () => {
    const options = parseArgs(["--no-model"], CWD)
    expect(options.driveModel).toBe(false)
    expect(options.model).toBeUndefined()
  })

  test("--json and --keep are switches", () => {
    const options = parseArgs(["--json", "--keep", "--no-model"], CWD)
    expect(options.json).toBe(true)
    expect(options.keep).toBe(true)
  })

  test("timeouts override the defaults", () => {
    const options = parseArgs(["--turn-timeout-ms", "1000", "--boot-timeout-ms", "2000"], CWD)
    expect(options.turnTimeoutMs).toBe(1000)
    expect(options.bootTimeoutMs).toBe(2000)
  })

  test("--scratch overrides the scratch root", () => {
    expect(parseArgs(["--scratch", "scratch-here"], CWD).scratchRoot).toBe(join(CWD, "scratch-here"))
    expect(parseArgs(["--scratch", "/var/tmp/harness"], CWD).scratchRoot).toBe("/var/tmp/harness")
  })

  test("rejects unknown arguments and contradictory ones", () => {
    expect(() => parseArgs(["--wat"], CWD)).toThrow(UsageError)
    expect(() => parseArgs(["--model", "no-slash"], CWD)).toThrow(UsageError)
    expect(() => parseArgs(["--model", "opencode/"], CWD)).toThrow(UsageError)
    expect(() => parseArgs(["--model", "/only-model"], CWD)).toThrow(UsageError)
    expect(() => parseArgs(["--model", "opencode/x", "--no-model"], CWD)).toThrow(UsageError)
    expect(() => parseArgs(["--turn-timeout-ms", "0"], CWD)).toThrow(UsageError)
    expect(() => parseArgs(["--turn-timeout-ms", "soon"], CWD)).toThrow(UsageError)
    expect(() => parseArgs(["--plugin"], CWD)).toThrow(UsageError)
    expect(() => parseArgs(["--plugin", "--json"], CWD)).toThrow(UsageError)
  })

  test("--help is recognised without parsing anything else", () => {
    expect(wantsHelp(["--help"])).toBe(true)
    expect(wantsHelp(["-h"])).toBe(true)
    expect(wantsHelp(["--no-model"])).toBe(false)
  })

  test("scratch ids are unique and path-safe", () => {
    const first = scratchId(1792017900455, "abc123")
    const second = scratchId(1792017900455, "abc124")
    expect(first).not.toBe(second)
    expect(first).toMatch(/^[0-9a-z]+-[0-9a-z]+$/)
  })
})
