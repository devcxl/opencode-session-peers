/**
 * The report is the harness's product, so its shape and its rendering are
 * checked here: a reader must be able to see both sessions, both directories,
 * and exactly which expectation failed with what was observed.
 */

import { describe, expect, test } from "bun:test"
import { expectationsMet, renderReport, type HarnessReport } from "../scripts/harness/report.ts"

function report(overrides: Partial<HarnessReport> = {}): HarnessReport {
  return {
    ok: true,
    mode: "drive",
    startedAt: "2026-10-15T00:00:00.000Z",
    finishedAt: "2026-10-15T00:00:12.000Z",
    durationMs: 12_000,
    expectations: [
      { name: "instance-boots", met: true, expected: "the instance answers", observed: "answered in 800 ms" },
    ],
    sessions: [
      {
        label: "A",
        id: "ses_a",
        directory: "/scratch/project-a",
        title: "harness-a",
        model: "opencode/free",
        outcome: "succeeded",
        messages: [
          { type: "user", text: "Reply with exactly HARNESS_SESSION_A_OK" },
          { type: "assistant", text: "HARNESS_SESSION_A_OK", finish: "stop" },
        ],
      },
      {
        label: "B",
        id: "ses_b",
        directory: "/scratch/project-b",
        title: "harness-b",
        outcome: "succeeded",
        messages: [],
      },
    ],
    plugin: {
      path: "/repo/plugin",
      entrypoint: "/repo/plugin/index.ts",
      installedIn: ["./project-a/.opencode/opencode.json", "./project-b/.opencode/opencode.json"],
      loaded: true,
      locations: ["/scratch/project-a", "/scratch/project-b"],
    },
    model: { requested: "opencode/free", used: ["opencode/free"] },
    disclosures: ["read /home/dev/.local/state/opencode/service.json to hash it; it is never written"],
    cleanup: {
      processStopped: true,
      portClosed: true,
      scratchRemoved: true,
      scratchKept: false,
      authFileRemoved: true,
      observed: "instance: stopped after SIGTERM",
    },
    ...overrides,
  }
}

describe("report shape", () => {
  test("a report survives JSON serialisation unchanged", () => {
    const original = report()
    expect(JSON.parse(JSON.stringify(original))).toEqual(original)
  })

  test("ok requires every expectation to be met", () => {
    expect(expectationsMet(report().expectations)).toBe(true)
    expect(
      expectationsMet([
        { name: "a", met: true, expected: "x", observed: "y" },
        { name: "b", met: false, expected: "x", observed: "z" },
      ]),
    ).toBe(false)
  })
})

describe("report rendering", () => {
  const text = renderReport(report())

  test("names both sessions and both directories", () => {
    expect(text).toContain("ses_a")
    expect(text).toContain("ses_b")
    expect(text).toContain("/scratch/project-a")
    expect(text).toContain("/scratch/project-b")
  })

  test("shows the mode, the plugin and the isolation evidence", () => {
    expect(text).toContain("model-driven mode")
    expect(text).toContain("/repo/plugin")
    expect(text).toContain("loaded     yes")
    expect(text).toContain("service.json to hash it")
    expect(text).toContain("auth.json removed  yes")
  })

  test("a failed expectation prints the expectation and the observed value", () => {
    const failing = report({
      ok: false,
      expectations: [
        { name: "turn-completes", met: false, expected: "a turn reaches a terminal outcome", observed: "B: failed (provider.auth)" },
      ],
    })
    const rendered = renderReport(failing)
    expect(rendered).toContain("ok        NO")
    expect(rendered).toContain("FAIL  turn-completes")
    expect(rendered).toContain("expected a turn reaches a terminal outcome")
    expect(rendered).toContain("observed B: failed (provider.auth)")
  })

  test("structural mode and a kept scratch directory read as intended", () => {
    const structural = report({
      mode: "structural",
      cleanup: { ...report().cleanup, scratchRemoved: false, scratchKept: true },
    })
    const rendered = renderReport(structural)
    expect(rendered).toContain("structural mode")
    expect(rendered).toContain("kept (--keep)")
  })
})
