/**
 * Sending to a peer.
 *
 * Seam 2 again: the plugin's entry point against fake hosts that share one
 * storage, the way two real locations share one machine. What is asserted is
 * what the model reads back, and what the plugin asked its host to hand to
 * which session, at which delivery — never internal call order or private
 * state. One plugin instance serves one location, so a send is issued through
 * the sender's host and addressed to the recipient's session.
 */

import { describe, expect, test } from "bun:test"

import { peerKey } from "../src/host/storage.ts"
import type { Peer } from "../src/domain/types.ts"
import plugin from "../src/index.ts"
import { fakeHost, fakeStorage, type FakeHostOptions, type FakeStorage } from "./fake-host.ts"

const ALPHA = { id: "ses_aaaa1111", title: "Payments API" }
const BETA = { id: "ses_bbbb2222", title: "Docs site" }
const TWIN = { id: "ses_bbbb3333", title: "Docs site" }

/** Load the plugin into a fake host, as the host would, and keep the unload. */
async function loaded(options: FakeHostOptions) {
  const host = fakeHost(options)
  const cleanup = await plugin.setup(host.context)
  return {
    host,
    async unload() {
      if (typeof cleanup === "function") await cleanup()
    },
  }
}

type Instance = Awaited<ReturnType<typeof loaded>>

/** Let the plugin's subscription and the work it started run to a stop. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Two locations on one machine: alpha in one directory, beta in the other, both
 * published so each can address the other. Extra fake-host options (a refusal,
 * a config) apply to the side that is named, the sending side by default.
 */
async function twoDirectories(
  options: { alpha?: FakeHostOptions; beta?: FakeHostOptions } = {},
) {
  const storage = fakeStorage()
  const alpha = await loaded({
    location: "/work/alpha",
    caller: ALPHA.id,
    storage,
    sessions: [ALPHA],
    ...options.alpha,
  })
  const beta = await loaded({
    location: "/work/beta",
    caller: BETA.id,
    storage,
    sessions: [BETA],
    ...options.beta,
  })

  // Beta has been created and has not started anything: idle, so a message to
  // it starts its own turn unless a test says otherwise.
  beta.host.emit("session.created", { sessionID: BETA.id })
  await settle()

  // Both sides are addressable only once they are on the roster.
  await alpha.host.call("peers", { action: "list" })
  await beta.host.call("peers", { action: "list" })
  return { alpha, beta, storage }
}

async function unloadAll(...instances: Instance[]): Promise<void> {
  for (const instance of instances) await instance.unload()
}

/** The roster record of one session, whoever wrote it. */
function recordFor(storage: FakeStorage, sessionID: string): Peer | undefined {
  const records = storage
    .values()
    .filter((value): value is Peer => typeof value === "object" && value !== null && "sessionID" in value)
  return records.find((peer) => peer.sessionID === sessionID)
}

/** A record as another instance would have published it. */
function peerRecord(overrides: Partial<Peer> & { sessionID: string }): Peer {
  return {
    title: "peer session",
    directory: "/work/elsewhere",
    scope: "default",
    // Every live instance publishes a declaration, so a crafted record carries
    // one unless a test is about a record that predates the field.
    inboundTrigger: "always",
    instanceID: "instance-other",
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe("delivering a message", () => {
  test("hands the other directory's session the body, addressed by title", async () => {
    const { alpha, beta } = await twoDirectories()

    const result = await alpha.host.call("peers", {
      action: "send",
      to: "Docs site",
      message: "The API is frozen for review.",
    })

    expect(result.text).toBe("Message sent to Docs site")
    expect(result.details).toEqual({
      delivered: true,
      delivery: "queue",
      sessionID: BETA.id,
      title: "Docs site",
      directory: "/work/beta",
      status: "idle",
      self: false,
    })
    // The host was asked to hand the recipient the body its model will read:
    // sender, sender's directory, reply hint, message.
    expect(alpha.host.prompts).toEqual([
      {
        sessionID: BETA.id,
        text: [
          `**From Payments API** (/work/alpha)`,
          `To reply: peers({ action: "reply", message: "..." })`,
          "",
          "The API is frozen for review.",
        ].join("\n"),
        delivery: "queue",
      },
    ])
    expect(beta.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })

  test("resolves the short id shown by list, and carries attachments after the body", async () => {
    const { alpha, beta } = await twoDirectories()

    const result = await alpha.host.call("peers", {
      action: "send",
      to: "ses_bbbb",
      message: "context attached",
      attachments: [
        { type: "snippet", name: "handler.ts", content: "export const x = 1", language: "ts" },
        { type: "context", name: "notes", content: "why we did this" },
      ],
    })

    expect(result.text).toBe("Message sent to Docs site")
    const sent = alpha.host.prompts[0]
    expect(sent?.sessionID).toBe(BETA.id)
    expect(sent?.text).toContain("--- snippet: handler.ts ts ---\nexport const x = 1")
    expect(sent?.text).toContain("--- context: notes ---\nwhy we did this")
    expect(sent?.text.indexOf("context attached")).toBeLessThan(
      sent?.text.indexOf("--- snippet: handler.ts ts ---") ?? -1,
    )

    await unloadAll(alpha, beta)
  })

  test("leaves the reply hint out when the sender's configuration asks it to", async () => {
    const { alpha, beta } = await twoDirectories({ alpha: { options: { replyHint: false } } })

    await alpha.host.call("peers", { action: "send", to: BETA.id, message: "no hint please" })

    expect(alpha.host.prompts[0]?.text).toBe(
      `**From Payments API** (/work/alpha)\n\nno hint please`,
    )

    await unloadAll(alpha, beta)
  })

  test("sends a message that is only attachments", async () => {
    const { alpha, beta } = await twoDirectories()

    const result = await alpha.host.call("peers", {
      action: "send",
      to: BETA.id,
      attachments: [{ type: "file", name: "a.txt", content: "only this" }],
    })

    expect(result.details).toMatchObject({ delivered: true })
    expect(alpha.host.prompts[0]?.text).toContain("--- file: a.txt ---\nonly this")

    await unloadAll(alpha, beta)
  })
})

describe("the delivery decision", () => {
  test("queues for an idle recipient, so the message starts its own turn", async () => {
    const { alpha, beta, storage } = await twoDirectories()
    expect(recordFor(storage, BETA.id)?.status).toBe("idle")

    const result = await alpha.host.call("peers", { action: "send", to: BETA.id, message: "ping" })

    expect(result.details).toMatchObject({ delivered: true, delivery: "queue" })
    expect(alpha.host.prompts[0]?.delivery).toBe("queue")

    await unloadAll(alpha, beta)
  })

  test("steers into a recipient that is mid-turn, without aborting it", async () => {
    const { alpha, beta, storage } = await twoDirectories()
    beta.host.emit("session.execution.started", { sessionID: BETA.id })
    await settle()
    expect(recordFor(storage, BETA.id)?.status).toBe("busy")

    const result = await alpha.host.call("peers", { action: "send", to: BETA.id, message: "ping" })

    expect(result.details).toMatchObject({ delivered: true, delivery: "steer" })
    expect(alpha.host.prompts[0]?.delivery).toBe("steer")

    await unloadAll(alpha, beta)
  })

  test("uses the configured busy delivery when the recipient is mid-turn", async () => {
    const { alpha, beta } = await twoDirectories({ alpha: { options: { busyDelivery: "queue" } } })
    beta.host.emit("session.execution.started", { sessionID: BETA.id })
    await settle()

    const result = await alpha.host.call("peers", { action: "send", to: BETA.id, message: "ping" })

    expect(result.details).toMatchObject({ delivered: true, delivery: "queue" })
    expect(alpha.host.prompts[0]?.delivery).toBe("queue")

    await unloadAll(alpha, beta)
  })

  test("assumes the recipient is not idle when the roster has no status for it", async () => {
    const { alpha, beta, storage } = await twoDirectories()
    // A record written by an instance that never saw a status, as one seeded
    // from storage before its session ran a turn is.
    await storage.set(
      peerKey(BETA.id),
      peerRecord({ sessionID: BETA.id, title: "Docs site", directory: "/work/beta" }),
    )

    const result = await alpha.host.call("peers", { action: "send", to: BETA.id, message: "ping" })

    expect(result.details).toMatchObject({ delivered: true, delivery: "steer" })

    await unloadAll(alpha, beta)
  })
})

describe("the recipient's declared policy", () => {
  test("a peer that declares never is not sent to, and its record says so", async () => {
    const { alpha, beta, storage } = await twoDirectories({ beta: { options: { trigger: "never" } } })
    // The declaration travels: it is on the record the sending instance read.
    expect(recordFor(storage, BETA.id)?.inboundTrigger).toBe("never")

    const result = await alpha.host.call("peers", { action: "send", to: "Docs site", message: "ping" })

    const reason = `Session "Docs site" does not accept peer messages.`
    expect(result.text).toBe(reason)
    expect(result.details).toEqual({
      delivered: false,
      code: "E_TARGET_REFUSES",
      reason,
      retryable: false,
      sessionID: BETA.id,
    })
    expect(alpha.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })

  test("a peer that declares replies refuses a plain message", async () => {
    const { alpha, beta, storage } = await twoDirectories({ beta: { options: { trigger: "replies" } } })
    expect(recordFor(storage, BETA.id)?.inboundTrigger).toBe("replies")

    const result = await alpha.host.call("peers", { action: "send", to: "Docs site", message: "ping" })

    const reason = `Session "Docs site" accepts peer messages only as answers to its own questions, and this is a new message.`
    expect(result.text).toBe(reason)
    expect(result.details).toEqual({
      delivered: false,
      code: "E_TARGET_REPLIES_ONLY",
      reason,
      retryable: false,
      sessionID: BETA.id,
    })
    expect(alpha.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })

  test("a peer that declares always is delivered to as usual", async () => {
    const { alpha, beta, storage } = await twoDirectories({ beta: { options: { trigger: "always" } } })
    expect(recordFor(storage, BETA.id)?.inboundTrigger).toBe("always")

    const result = await alpha.host.call("peers", { action: "send", to: BETA.id, message: "ping" })

    expect(result.details).toMatchObject({ delivered: true, delivery: "queue" })
    expect(alpha.host.prompts).toHaveLength(1)

    await unloadAll(alpha, beta)
  })

  test("a record that carries no declaration is refused, not assumed open", async () => {
    const { alpha, beta, storage } = await twoDirectories()
    // What a record written before the roster carried the field looks like.
    await storage.set(peerKey(TWIN.id), {
      sessionID: TWIN.id,
      title: "Old build",
      directory: "/work/beta",
      scope: "default",
      instanceID: "instance-old",
      updatedAt: Date.now(),
    })

    const result = await alpha.host.call("peers", { action: "send", to: "Old build", message: "ping" })

    const reason = `Session "Old build" has not declared what it accepts from peers, so this message is refused. It may still be running an older build.`
    expect(result.text).toBe(reason)
    expect(result.details).toEqual({
      delivered: false,
      code: "E_TARGET_POLICY_UNKNOWN",
      reason,
      retryable: false,
      sessionID: TWIN.id,
    })
    expect(alpha.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })
})

describe("targets that fail closed", () => {
  test("an unknown target gets the ported text, and nothing is delivered", async () => {
    const { alpha, beta } = await twoDirectories()

    const result = await alpha.host.call("peers", { action: "send", to: "Nobody here", message: "hello?" })

    const reason = `Session "Nobody here" is not connected. Blocking asks are not queued; use "send" or retry once it reconnects.`
    expect(result.text).toBe(reason)
    expect(result.details).toEqual({
      delivered: false,
      code: "E_TARGET_NOT_FOUND",
      reason,
      retryable: false,
    })
    expect(alpha.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })

  test("an ambiguous title gets the ported text and names the candidates", async () => {
    const { alpha, beta, storage } = await twoDirectories()
    await storage.set(
      peerKey(TWIN.id),
      peerRecord({ sessionID: TWIN.id, title: TWIN.title, directory: "/work/beta" }),
    )

    const result = await alpha.host.call("peers", { action: "send", to: "Docs site", message: "hello?" })

    const reason = `Multiple sessions match "Docs site". Address one by the session id shown in parentheses by "list".`
    expect(result.text).toBe(reason)
    expect(result.details).toEqual({
      delivered: false,
      code: "E_TARGET_AMBIGUOUS",
      reason,
      retryable: false,
      candidates: [BETA.id, TWIN.id],
    })
    expect(alpha.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })

  test("an ambiguous id prefix gets the same refusal", async () => {
    const { alpha, beta, storage } = await twoDirectories()
    await storage.set(
      peerKey(TWIN.id),
      peerRecord({ sessionID: TWIN.id, title: "Something else", directory: "/work/beta" }),
    )

    const result = await alpha.host.call("peers", { action: "send", to: "ses_bbbb", message: "hello?" })

    expect(result.details).toMatchObject({ code: "E_TARGET_AMBIGUOUS", candidates: [BETA.id, TWIN.id] })

    await unloadAll(alpha, beta)
  })

  test("the current session cannot message itself, by id or by title", async () => {
    const { alpha, beta } = await twoDirectories()

    const byID = await alpha.host.call("peers", { action: "send", to: ALPHA.id, message: "hello me" })
    expect(byID.text).toBe("Cannot message the current session")
    expect(byID.details).toMatchObject({ delivered: false, code: "E_SELF_TARGET", retryable: false })

    const byTitle = await alpha.host.call("peers", { action: "send", to: "Payments API", message: "hello me" })
    expect(byTitle.text).toBe("Cannot message the current session")

    expect(alpha.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })

  test("a message with neither text nor attachments is refused", async () => {
    const { alpha, beta } = await twoDirectories()

    const result = await alpha.host.call("peers", { action: "send", to: BETA.id, message: "   " })

    expect(result.text).toBe("A message needs text or at least one attachment.")
    expect(result.details).toMatchObject({ delivered: false, code: "E_MESSAGE_EMPTY" })
    expect(alpha.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })

  test("an attachment without a type, a name or content is refused", async () => {
    const { alpha, beta } = await twoDirectories()

    const malformed = [
      [{ name: "a.txt", content: "x" }],
      [{ type: "snippet", name: "  ", content: "x" }],
      [{ type: "file", name: "a.txt" }],
      [{ type: "sticker", name: "a.txt", content: "x" }],
    ]
    for (const attachments of malformed) {
      const result = await alpha.host.call("peers", { action: "send", to: BETA.id, attachments })
      expect(result.text).toBe("Attachments need a type of file, snippet or context, a name, and content.")
      expect(result.details).toMatchObject({ delivered: false, code: "E_ATTACHMENT_INVALID" })
    }
    expect(alpha.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })

  test("a disabled plugin sends nothing and says why", async () => {
    const alpha = await loaded({
      location: "/work/alpha",
      caller: ALPHA.id,
      options: { enabled: false },
      sessions: [ALPHA],
    })

    const result = await alpha.host.call("peers", { action: "send", to: BETA.id, message: "hello?" })

    expect(result.text).toBe("Session peers is disabled by configuration.")
    expect(result.details).toMatchObject({ delivered: false, code: "E_DISABLED" })
    expect(alpha.host.prompts).toEqual([])

    await alpha.unload()
  })
})

describe("a recipient that has gone away", () => {
  test("a refused delivery is reported as undelivered, with the host's reason kept", async () => {
    // The roster record is still fresh — the sender resolves the target — but
    // the host no longer runs that session, as when it exits between the two.
    const { alpha, beta } = await twoDirectories({ alpha: { promptRefuses: [BETA.id] } })

    const result = await alpha.host.call("peers", { action: "send", to: "Docs site", message: "anyone there?" })

    const reason = `Message to "Docs site" was not delivered: the host no longer runs that session. Use "list" to see who is still connected.`
    expect(result.text).toBe(reason)
    expect(result.details).toEqual({
      delivered: false,
      code: "E_DELIVERY_FAILED",
      reason,
      retryable: false,
      sessionID: BETA.id,
      hostError: "Session.NotFoundError",
    })
    expect(alpha.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })
})
