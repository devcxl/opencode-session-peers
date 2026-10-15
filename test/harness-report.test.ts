/**
 * The report is the harness's product, so its shape and its rendering are
 * checked here: a reader must be able to see both sessions, both directories,
 * and exactly which expectation failed with what was observed.
 */

import { describe, expect, test } from "bun:test"
import { explain, expectationsMet, renderReport, type HarnessReport } from "../scripts/harness/report.ts"

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

describe("explain", () => {
  test("errors, bare strings and unknown values all read as one line", () => {
    expect(explain(new Error("the port was taken"))).toBe("the port was taken")
    expect(explain(new TypeError("bad shape"))).toBe("bad shape")
    expect(explain("plain text")).toBe("plain text")
    expect(explain({ code: "ENOENT" })).toBe('{"code":"ENOENT"}')
  })

  test("an error with no message still names itself", () => {
    const named = new Error("")
    named.name = "Session.NotFoundError"
    expect(explain(named)).toBe("Session.NotFoundError")
  })
})

describe("report rendering", () => {  const text = renderReport(report())

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

  test("a plugin with no entrypoint reads as not asserted, not as not loaded", () => {
    const rendered = renderReport(
      report({
        plugin: {
          path: "/repo/plugin",
          installedIn: ["project-a/.opencode/opencode.json"],
          loaded: false,
          locations: ["/scratch/project-a", "/scratch/project-b"],
        },
      }),
    )
    expect(rendered).toContain("loaded     not asserted (no entrypoint yet)")
    expect(rendered).toContain("locations: /scratch/project-a, /scratch/project-b")
  })

  test("structural mode says plainly that no turn was driven", () => {
    const rendered = renderReport(report({ mode: "structural", model: { used: [] } }))
    expect(rendered).toContain("structural mode")
    expect(rendered).toContain("model     not driven (structural pass; pass --model to drive the turns)")
  })

  test("the driven mode says plainly what it depends on", () => {
    expect(text).toContain("turns depend on the host's model backend serving a fresh instance")
    expect(text).toContain("used: opencode/free")
  })

  test("offline mode says the stub drove the turns, with no hosted model and no credentials", () => {
    const rendered = renderReport(
      report({ mode: "offline", model: { requested: "harness-stub/stub", used: ["harness-stub/stub"] } }),
    )
    expect(rendered).toContain("offline stub-model mode")
    expect(rendered).toContain("model     requested: harness-stub/stub")
    expect(rendered).toContain("offline, deterministic, no hosted model, no credentials")
    expect(rendered).toContain("used: harness-stub/stub")
    expect(rendered).not.toContain("turns depend on the host's model backend")
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
