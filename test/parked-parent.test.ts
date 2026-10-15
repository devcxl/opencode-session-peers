/**
 * The supervisor channel: a child reaching its own parent (ADR-0002).
 *
 * Seam 2: a fake host serving one location, because a subagent child is created
 * in its parent's directory and is served by the same plugin instance. What is
 * asserted is what the model reads back, and what the plugin asked the host to
 * do — never how the probe is wired inside. The parent's parked-ness is posed as
 * a transcript, which is exactly the evidence the rule reads.
 */

import { describe, expect, test } from "bun:test"

import { parentParking } from "../src/domain/parked-parent.ts"
import type { ToolCallRecord } from "../src/domain/types.ts"
import plugin from "../src/index.ts"
import { fakeHost, fakeStorage, type FakeSession, type FakeStorage } from "./fake-host.ts"

const PARENT: FakeSession = { id: "ses_pppp0001", title: "Main task" }
const CHILD: FakeSession = { id: "ses_cccc0002", title: "Fibre probe", parentID: PARENT.id }
const NEIGHBOUR: FakeSession = { id: "ses_nnnn0003", title: "Neighbour" }

const REFUSAL =
  `"Main task" is your parent session and is blocked waiting for you to finish, ` +
  `so it cannot answer inside this turn. ` +
  `Use "send" to hand it the question together with your recommendation, or raise it in your final report.`

/** The `subagent` call a parent sits inside: running, and naming the child it spawned. */
function subagentCall(named: "input" | "metadata", childID: string): ToolCallRecord {
  return {
    name: "subagent",
    status: "running",
    input: named === "input" ? { sessionID: childID, agent: "general" } : { agent: "general" },
    metadata: named === "metadata" ? { sessionID: childID, status: "running" } : {},
  }
}

function call(overrides: Partial<ToolCallRecord>): ToolCallRecord {
  return { name: "subagent", status: "running", input: {}, metadata: {}, ...overrides }
}

/**
 * One location serving a parent and a child it spawned, both published. `parent`
 * is the transcript the child's probe will read; the caller of the tool is the
 * child unless a test overrides it.
 */
async function family(options: {
  readonly parent?: Partial<FakeSession>
  readonly caller?: FakeSession
  readonly extra?: readonly FakeSession[]
  /** Plugin options, on top of the two-second ask timeout every case here uses. */
  readonly pluginOptions?: Readonly<Record<string, unknown>>
  readonly contextRefuses?: readonly string[]
} = {}) {
  const parent: FakeSession = { ...PARENT, ...options.parent }
  const caller = options.caller ?? CHILD
  const sessions = [parent, caller, ...(options.extra ?? [])]
  const host = fakeHost({
    location: "/work/house",
    caller: caller.id,
    sessions,
    // A two-second ask timeout polls the reply slot every 100 ms instead of
    // once a second, so a case that ends in an answer does not idle for a second.
    options: { askTimeoutMs: 2_000, ...options.pluginOptions },
    ...(options.contextRefuses === undefined ? {} : { contextRefuses: options.contextRefuses }),
  })
  const cleanup = await plugin.setup(host.context)
  for (const session of sessions) host.emit("session.created", { sessionID: session.id })
  await settle()
  await host.call("peers", { action: "list" }, caller.id)
  return {
    host,
    parent,
    caller,
    async unload() {
      if (typeof cleanup === "function") await cleanup()
    },
  }
}

type Family = Awaited<ReturnType<typeof family>>

/** Let the plugin's subscription and the work it started run to a stop. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Wait for a message the plugin hands to a session; fail loudly if it never does. */
async function waitForMessage(host: { prompts: readonly unknown[] }): Promise<void> {
  for (let turn = 0; turn < 400; turn += 1) {
    if (host.prompts.length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("timed out waiting for the plugin to hand a message to the host")
}

/** Every value stored under one prefix, the way another instance would read it. */
async function stored(storage: FakeStorage, prefix: string): Promise<unknown[]> {
  const values: unknown[] = []
  let after: string | undefined
  for (;;) {
    const page = await storage.scan(after === undefined ? { prefix } : { prefix, after })
    values.push(...page.entries.map((entry) => entry.value))
    if (page.next === undefined || page.next === after) return values
    after = page.next
  }
}

async function unload(instance: Family): Promise<void> {
  await instance.unload()
}

describe("the parked-parent rule", () => {
  test("a session no subagent spawned has no supervisor channel", () => {
    expect(parentParking({ parentID: undefined, childID: CHILD.id, calls: [] })).toBe("not-parent")
  })

  test("a parent whose transcript cannot be read is not called parked", () => {
    expect(parentParking({ parentID: PARENT.id, childID: CHILD.id, calls: undefined })).toBe("unknown")
  })

  test("a parent inside the subagent call that names this child is parked", () => {
    expect(
      parentParking({ parentID: PARENT.id, childID: CHILD.id, calls: [subagentCall("input", CHILD.id)] }),
    ).toBe("parked")
    // A new spawn carries no session id in its input; the tool records the child
    // it created as progress metadata (docs/research/subagent-lifecycle.md §1.2).
    expect(
      parentParking({ parentID: PARENT.id, childID: CHILD.id, calls: [subagentCall("metadata", CHILD.id)] }),
    ).toBe("parked")
  })

  test("a parent is not parked for anything short of that", () => {
    const other = "ses_other0009"
    expect(
      parentParking({
        parentID: PARENT.id,
        childID: CHILD.id,
        calls: [
          call({ status: "completed", input: { sessionID: CHILD.id } }),
          call({ status: "running", input: { sessionID: other } }),
          call({ name: "shell", status: "running", input: { command: "sleep 60" } }),
          call({ status: "running", input: {} }),
          call({ status: "running", input: {}, metadata: { sessionID: other } }),
        ],
      }),
    ).toBe("answerable")
  })
})

describe("a child asking its parked parent", () => {
  test("is refused at once, with the question still in its hands", async () => {
    const instance = await family({
      parent: { toolCalls: [subagentCall("metadata", CHILD.id)] },
      // The 10-minute default wait is never reached: a probe that failed would
      // hang this call, and bun's own test timeout is what catches that.
      pluginOptions: { askTimeoutMs: 600_000 },
    })

    const result = await instance.host.call(
      "peers",
      { action: "ask", to: PARENT.id, message: "Which index?" },
      CHILD.id,
    )

    expect(result.text).toBe(REFUSAL)
    expect(result.details).toEqual({
      delivered: false,
      code: "E_TARGET_UNREACHABLE",
      reason: REFUSAL,
      retryable: false,
      sessionID: PARENT.id,
      parentProbe: "parked",
    })
    // Nothing was asked: no record left behind, no message in the parent's inbox
    // for the one moment it cannot read it.
    expect(instance.host.prompts).toEqual([])
    expect(await stored(instance.host.storage, "v1/asks/")).toEqual([])
    // The parent's own transcript is what proved it, and only that one was read.
    expect(instance.host.transcriptReads).toEqual([PARENT.id])

    await unload(instance)
  })
})

describe("a child asking an answerable parent", () => {
  test("is delivered and answered like any other ask", async () => {
    const instance = await family({ parent: { toolCalls: [] } })

    const asking = instance.host.call("peers", { action: "ask", to: PARENT.id, message: "Ship it?" }, CHILD.id)
    await waitForMessage(instance.host)
    expect(instance.host.prompts[0]?.sessionID).toBe(PARENT.id)

    const answered = await instance.host.call("peers", { action: "reply", message: "Ship it." }, PARENT.id)
    expect(answered.text).toBe("Reply sent to Fibre probe")

    expect((await asking).text).toBe("**Reply from Main task:**\nShip it.")

    await unload(instance)
  })

  test("a parent parked on a different child is asked, not refused", async () => {
    const instance = await family({ parent: { toolCalls: [subagentCall("input", "ses_other0009")] } })

    const asking = instance.host.call("peers", { action: "ask", to: PARENT.id, message: "Yours?" }, CHILD.id)
    await waitForMessage(instance.host)
    expect(instance.host.prompts[0]?.sessionID).toBe(PARENT.id)

    await instance.host.call("peers", { action: "reply", message: "Not mine." }, PARENT.id)
    expect((await asking).text).toBe("**Reply from Main task:**\nNot mine.")

    await unload(instance)
  })

  test("a session with no parent is never refused, even when the target's transcript names it", async () => {
    const stranger: FakeSession = {
      id: "ses_ssss0004",
      title: "Stranger",
      // Evidence that would prove a parked parent — for someone else's child.
      toolCalls: [subagentCall("metadata", NEIGHBOUR.id)],
    }
    const instance = await family({ caller: NEIGHBOUR, extra: [stranger] })

    const asking = instance.host.call("peers", { action: "ask", to: stranger.id, message: "Ask away" }, NEIGHBOUR.id)
    await waitForMessage(instance.host)
    expect(instance.host.prompts[0]?.sessionID).toBe(stranger.id)
    expect(instance.host.transcriptReads).toEqual([])

    await instance.host.call("peers", { action: "reply", message: "Answered." }, stranger.id)
    expect((await asking).text).toBe("**Reply from Stranger:**\nAnswered.")

    await unload(instance)
  })

  test("a parent whose transcript cannot be read is asked anyway, and the failure is said out loud", async () => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "))
    }
    try {
      const instance = await family({
        parent: { toolCalls: [subagentCall("metadata", CHILD.id)] },
        contextRefuses: [PARENT.id],
      })

      const asking = instance.host.call(
        "peers",
        { action: "ask", to: PARENT.id, message: "Unreadable?" },
        CHILD.id,
      )
      await waitForMessage(instance.host)
      // The message went out: an unprovable probe must not take the decision
      // away from a parent that might still answer.
      expect(instance.host.prompts[0]?.sessionID).toBe(PARENT.id)
      expect(warnings.some((line) => line.includes("could not read"))).toBe(true)

      await instance.host.call("peers", { action: "reply", message: "Read you." }, PARENT.id)
      expect((await asking).text).toBe("**Reply from Main task:**\nRead you.")

      await unload(instance)
    } finally {
      console.warn = original
    }
  })
})

describe("a child reporting progress to its parent", () => {
  test("reaches a parked parent, and says when it will be read", async () => {
    const instance = await family({ parent: { toolCalls: [subagentCall("metadata", CHILD.id)] } })

    const result = await instance.host.call(
      "peers",
      { action: "send", to: PARENT.id, message: "Halfway through the index rebuild." },
      CHILD.id,
    )

    expect(result.text).toBe(
      "Message sent to Main task; it is blocked waiting for this run to end, so it will read the message then.",
    )
    expect(result.details).toEqual({
      delivered: true,
      delivery: "queue",
      parentProbe: "parked",
      sessionID: PARENT.id,
      title: "Main task",
      directory: "/work/house",
      self: false,
      status: "idle",
    })
    expect(instance.host.prompts).toHaveLength(1)
    expect(instance.host.prompts[0]?.text).toContain("Halfway through the index rebuild.")

    await unload(instance)
  })

  test("says nothing extra to a parent that can read it now", async () => {
    const instance = await family({ parent: { toolCalls: [] } })

    const result = await instance.host.call("peers", { action: "send", to: PARENT.id, message: "Starting now." }, CHILD.id)

    expect(result.text).toBe("Message sent to Main task")
    expect(result.details).not.toHaveProperty("parentProbe")

    await unload(instance)
  })
})

describe("the parent-side text", () => {
  test("is registered as a skill whose description and content say how to stay answerable", async () => {
    const host = fakeHost()
    await plugin.setup(host.context)

    expect(host.skills).toHaveLength(1)
    const skill = host.skills[0]!
    expect(skill.id).toBe("session-peers-supervisor")
    expect(skill.description).toContain("background: true")
    expect(skill.content).toContain("`background: true`")
    expect(skill.content).toContain("peers({ action: \"send\", ... })")
    // The text exists at the path the host is told, so the model can find it.
    expect(skill.path).toBe(new URL("../src/skill.ts", import.meta.url).pathname)
  })
})
