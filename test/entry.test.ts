/**
 * The entry path, driven through a fake host.
 *
 * This is the project's seam 2: `setup` is handed a fake context, and the test
 * asserts what the model receives and what the plugin asked the host to do —
 * never how the plugin is wired inside.
 */

import { describe, expect, test } from "bun:test"

import plugin from "../src/index.ts"
import { CALLER_SESSION_ID, fakeHost, type FakeHostOptions } from "./fake-host.ts"

/** Load the plugin into a fake host, the way the host would. */
async function loaded(options?: FakeHostOptions) {
  const host = fakeHost(options)
  await plugin.setup(host.context)
  return host
}

describe("the plugin definition", () => {
  test("carries the stable id the host scopes plugin state by", () => {
    expect(plugin.id).toBe("session-peers")
  })

  test("registers exactly one tool, exposed to the model rather than to code mode", async () => {
    const host = await loaded()
    expect(host.tools.map((tool) => tool.name)).toEqual(["peers"])
    expect(host.tools[0]?.options).toEqual({ codemode: false })
  })

  test("peers takes an action enum and nothing else, and names its actions in prose", async () => {
    const host = await loaded()
    const tool = host.tools[0]
    expect(tool?.input).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: { action: { type: "string", enum: ["list", "list-cwd", "status"] } },
    })
    for (const action of ["list", "list-cwd", "status"]) expect(tool?.description).toContain(action)
  })

  test("an action the tool does not have is refused, not answered", async () => {
    const host = await loaded()
    await expect(host.call("peers", { action: "send" })).rejects.toThrowError("Unknown peers action: send")
  })
})

describe("status", () => {
  test("reports the calling session and that the host answers", async () => {
    const host = await loaded()
    const result = await host.call("peers", { action: "status" })
    expect(result.text).toBe(
      `**Session peers status:**\nConnected: yes\nSession ID: ${CALLER_SESSION_ID}\nScope: default`,
    )
    expect(result.details).toEqual({
      connected: true,
      sessionID: CALLER_SESSION_ID,
      scope: "default",
    })
    expect(host.lookups).toEqual([CALLER_SESSION_ID])
  })

  test("says the plugin is not connected when the host cannot resolve the session", async () => {
    const host = await loaded({ sessions: [] })
    const result = await host.call("peers", { action: "status" })
    expect(result.text).toBe("Session peers is not connected: Session.NotFoundError.")
    expect(result.details).toEqual({
      connected: false,
      sessionID: CALLER_SESSION_ID,
      scope: "default",
      code: "E_NOT_CONNECTED",
      reason: "Session peers is not connected: Session.NotFoundError.",
    })
  })

  test("fails closed when disabled, without asking the host", async () => {
    const host = await loaded({ options: { enabled: false } })
    const result = await host.call("peers", { action: "status" })
    expect(result.text).toBe("Session peers is disabled by configuration.")
    expect(result.details).toEqual({
      connected: false,
      sessionID: CALLER_SESSION_ID,
      scope: "default",
      code: "E_DISABLED",
      reason: "Session peers is disabled by configuration.",
    })
    expect(host.lookups).toEqual([])
  })

  test("reports the configured scope", async () => {
    const host = await loaded({ options: { scope: "team-a" } })
    const result = await host.call("peers", { action: "status" })
    expect(result.text).toContain("Scope: team-a")
    expect(result.details).toMatchObject({ scope: "team-a" })
  })
})

describe("configuration warnings", () => {
  test("surface once at load, and never during a call", async () => {
    const warnings = captureWarnings()
    try {
      const host = await loaded({ options: { scope: "   " } })
      expect(warnings.taken()).toHaveLength(1)
      expect(warnings.taken()[0]).toContain("scope")

      await host.call("peers", { action: "status" })
      expect(warnings.taken()).toHaveLength(1)
    } finally {
      warnings.restore()
    }
  })
})

function captureWarnings() {
  const messages: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "))
  }
  return {
    taken: () => messages,
    restore: () => {
      console.warn = original
    },
  }
}
