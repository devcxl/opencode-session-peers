/**
 * The general usage skill.
 *
 * The tool description lists actions; this text is what a session loads when it
 * actually coordinates, so it must name the actions, the rules that change how
 * a session works, and the refusals it will meet. The test asserts the facts
 * that would make the skill misleading if they drifted from the implementation.
 */

import { describe, expect, test } from "bun:test"

import plugin from "../src/index.ts"
import { fakeHost } from "./fake-host.ts"

async function skills() {
  const host = fakeHost()
  await plugin.setup(host.context)
  return host.skills
}

describe("the peers skill", () => {
  test("is registered beside the supervisor skill, under its own id", async () => {
    const registered = await skills()
    const ids = registered.map((skill) => skill.id)

    expect(ids).toContain("session-peers")
    expect(ids).toContain("session-peers-supervisor")
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("describes the coordination jobs a session would load it for", async () => {
    const skill = (await skills()).find((candidate) => candidate.id === "session-peers")!

    expect(skill.name).toBe("session-peers")
    for (const phrase of ["peers tool", "list live peers", "send a message", "ask a question", "hand over"]) {
      expect(skill.description).toContain(phrase)
    }
  })

  test("names every action the tool exposes", async () => {
    const skill = (await skills()).find((candidate) => candidate.id === "session-peers")!

    for (const action of [
      "list",
      "list-cwd",
      "send",
      "ask",
      "reply",
      "pending",
      "cancel",
      "handover",
      "status",
    ]) {
      expect(skill.content).toContain(`\`${action}\``)
    }
  })

  test("states the rules a coordinating session has to work around", async () => {
    const skill = (await skills()).find((candidate) => candidate.id === "session-peers")!

    expect(skill.content).toContain("no offline mailbox")
    expect(skill.content).toContain("A timeout is not cancellation.")
    expect(skill.content).toContain("not withdrawn")
    expect(skill.content).toContain('outcome: "unknown"')
    expect(skill.content).toContain("not atomic")
    expect(skill.content).not.toContain("cancel` withdraws")
    expect(skill.content).not.toContain("The host no longer runs the target session")
    expect(skill.content).toContain("background: true")
  })

  test("names the refusals the caller is expected to handle", async () => {
    const skill = (await skills()).find((candidate) => candidate.id === "session-peers")!

    for (const code of [
      "E_TARGET_NOT_FOUND",
      "E_TARGET_AMBIGUOUS",
      "E_TARGET_UNREACHABLE",
      "E_ASK_IN_FLIGHT",
      "E_MUTUAL_ASK",
      "E_ASK_UNANSWERED",
      "E_ASK_CANCELLED",
      "E_CANCEL_AMBIGUOUS",
      "E_HANDOVER_",
    ]) {
      expect(skill.content).toContain(code)
    }
  })

  test("points at the file the text lives in", async () => {
    const skill = (await skills()).find((candidate) => candidate.id === "session-peers")!

    expect(skill.path).toBe(new URL("../src/skill.ts", import.meta.url).pathname)
  })
})
