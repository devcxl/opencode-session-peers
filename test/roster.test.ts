/**
 * Peers become visible to each other.
 *
 * The seam is the project's second: the plugin's own entry point, driven against
 * fake hosts that share one storage the way the real ones share it per plugin
 * id. What is asserted is what the model reads and what the plugin asked the
 * host to keep — never internal call order or private state.
 */

import { describe, expect, test } from "bun:test"

import { peerKey } from "../src/host/storage.ts"
import type { Peer } from "../src/domain/types.ts"
import plugin from "../src/index.ts"
import { fakeHost, fakeStorage, type FakeHostOptions, type FakeStorage } from "./fake-host.ts"

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

/** Let the plugin's subscription and the work it started run to a stop. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** The roster records the host holds, whoever wrote them. */
function peerRecords(storage: FakeStorage): Peer[] {
  return storage.values().filter(isPeer)
}

function isPeer(value: unknown): value is Peer {
  return typeof value === "object" && value !== null && "sessionID" in value && "updatedAt" in value
}

/** A record as another instance would have published it. */
function peerRecord(overrides: Partial<Peer> & { sessionID: string }): Peer {
  return {
    title: "peer session",
    directory: "/work/elsewhere",
    scope: "default",
    instanceID: "instance-other",
    updatedAt: Date.now(),
    ...overrides,
  }
}

/**
 * What the result details say about a peer, written out field by field. Absent
 * facts are left out because a single `undefined` in tool metadata makes the
 * real host drop the whole result (`test/fake-host.ts` refuses one).
 */
function peerDetails(
  session: { id: string; title?: string },
  directory: string,
  status?: string,
): Readonly<Record<string, unknown>> {
  return {
    sessionID: session.id,
    title: session.title,
    directory,
    ...(status === undefined ? {} : { status }),
  }
}

const ALPHA = { id: "ses_aaaa1111", title: "Payments API" }
const BETA = { id: "ses_bbbb2222", title: "Docs site" }
const SIBLING = { id: "ses_ssss1111", title: "Sibling work" }

describe("publishing", () => {
  test("publishes one record per session, naming the instance that serves it", async () => {
    const storage = fakeStorage()
    const alpha = await loaded({ location: "/work/alpha", caller: ALPHA.id, storage, sessions: [ALPHA] })
    const beta = await loaded({ location: "/work/beta", caller: BETA.id, storage, sessions: [BETA] })

    await alpha.host.call("peers", { action: "list" })
    await beta.host.call("peers", { action: "list" })

    const records = peerRecords(storage)
    expect(records.map((peer) => peer.sessionID).sort()).toEqual([ALPHA.id, BETA.id])
    expect(records.find((peer) => peer.sessionID === ALPHA.id)).toMatchObject({
      title: "Payments API",
      directory: "/work/alpha",
      projectID: "proj_fake",
      scope: "default",
      inboundTrigger: "always",
    })
    // Which instance wrote a record is what lets a reload tell its own rows apart.
    expect(records[0]?.instanceID).not.toBe(records[1]?.instanceID)
    expect(records[0]?.updatedAt).toBeGreaterThan(0)

    await alpha.unload()
    await beta.unload()
  })

  test("publishes the inbound trigger this instance was configured with", async () => {
    const storage = fakeStorage()
    const alpha = await loaded({
      location: "/work/alpha",
      caller: ALPHA.id,
      storage,
      options: { trigger: "replies" },
      sessions: [ALPHA],
    })

    await alpha.host.call("peers", { action: "list" })

    // A session's declaration has to travel: the sender is the only instance
    // that can read it, and it reads it from here.
    expect(peerRecords(storage).find((peer) => peer.sessionID === ALPHA.id)?.inboundTrigger).toBe("replies")

    await alpha.unload()
  })

  test("takes in a session an event announces in this directory, with its status", async () => {
    const storage = fakeStorage()
    const alpha = await loaded({
      location: "/work/alpha",
      caller: ALPHA.id,
      storage,
      sessions: [ALPHA, SIBLING, { ...BETA, directory: "/work/beta" }],
    })

    alpha.host.emit("session.created", { sessionID: SIBLING.id })
    await settle()
    alpha.host.emit("session.execution.started", { sessionID: SIBLING.id })
    await settle()

    const result = await alpha.host.call("peers", { action: "list" })
    expect(result.text).toContain(`• Sibling work (ses_ssss) — /work/alpha (busy) [same cwd]`)

    // The stream is not filtered by location: the session's own directory decides.
    alpha.host.emit("session.created", { sessionID: BETA.id })
    await settle()
    expect(peerRecords(storage).map((peer) => peer.sessionID)).not.toContain(BETA.id)

    await alpha.unload()
  })

  test("drops a session the host reported deleted without waiting for the TTL", async () => {
    const storage = fakeStorage()
    const alpha = await loaded({
      location: "/work/alpha",
      caller: ALPHA.id,
      storage,
      sessions: [ALPHA, SIBLING],
    })

    alpha.host.emit("session.created", { sessionID: SIBLING.id })
    await settle()
    expect(peerRecords(storage).map((peer) => peer.sessionID)).toContain(SIBLING.id)

    alpha.host.emit("session.deleted", { sessionID: SIBLING.id })
    await settle()
    expect(peerRecords(storage).map((peer) => peer.sessionID)).not.toContain(SIBLING.id)

    await alpha.unload()
  })
})

describe("reading the roster", () => {
  test("a record whose heartbeats stopped is no peer after the TTL", async () => {    const storage = fakeStorage()
    const ttl = 5_000
    const alpha = await loaded({
      location: "/work/alpha",
      caller: ALPHA.id,
      storage,
      options: { rosterTtlMs: ttl },
      sessions: [ALPHA],
    })
    const quiet = peerRecord({
      sessionID: "ses_dddd4444",
      title: "Gone quiet",
      updatedAt: Date.now() - ttl - 1,
    })

    await storage.set(peerKey(quiet.sessionID), quiet)
    const stale = await alpha.host.call("peers", { action: "list" })
    expect(stale.text).not.toContain("Gone quiet")

    await storage.set(peerKey(quiet.sessionID), { ...quiet, updatedAt: Date.now() })
    const fresh = await alpha.host.call("peers", { action: "list" })
    expect(fresh.text).toContain("Gone quiet")

    await alpha.unload()
  })

  test("a peer in another scope is invisible", async () => {
    const storage = fakeStorage()
    const alpha = await loaded({
      location: "/work/alpha",
      caller: ALPHA.id,
      storage,
      options: { scope: "team-a" },
      sessions: [ALPHA],
    })

    await storage.set(
      peerKey("ses_dddd4444"),
      peerRecord({ sessionID: "ses_dddd4444", title: "Other team", scope: "team-b" }),
    )
    const foreign = await alpha.host.call("peers", { action: "list" })
    expect(foreign.text).not.toContain("Other team")

    await storage.set(
      peerKey("ses_dddd4444"),
      peerRecord({ sessionID: "ses_dddd4444", title: "Same team", scope: "team-a" }),
    )
    const own = await alpha.host.call("peers", { action: "list" })
    expect(own.text).toContain("Same team")

    await alpha.unload()
  })

  test("list names the session in the other directory, with its addressable prefix", async () => {
    const storage = fakeStorage()
    const alpha = await loaded({ location: "/work/alpha", caller: ALPHA.id, storage, sessions: [ALPHA] })
    const beta = await loaded({ location: "/work/beta", caller: BETA.id, storage, sessions: [BETA] })

    await alpha.host.call("peers", { action: "list" })
    const result = await beta.host.call("peers", { action: "list" })

    expect(result.text).toBe(
      [
        "**Current session:**",
        "• Docs site (ses_bbbb) — /work/beta [self]",
        "",
        "**Other sessions:**",
        "• Payments API (ses_aaaa) — /work/alpha",
      ].join("\n"),
    )
    expect(result.details).toEqual({
      roster: {
        peers: [
          { ...peerDetails(ALPHA, "/work/alpha"), self: false },
          { ...peerDetails(BETA, "/work/beta"), self: true },
        ],
        total: 2,
      },
    })

    await alpha.unload()
    await beta.unload()
  })

  test("list says so when this session is the only one", async () => {
    const alpha = await loaded({ location: "/work/alpha", caller: ALPHA.id, sessions: [ALPHA] })
    const result = await alpha.host.call("peers", { action: "list" })
    expect(result.text.endsWith("No other sessions connected.")).toBe(true)
    await alpha.unload()
  })

  test("list-cwd shows only the peers working in this session's directory", async () => {
    const storage = fakeStorage()
    const alpha = await loaded({
      location: "/work/alpha",
      caller: ALPHA.id,
      storage,
      sessions: [ALPHA, SIBLING],
    })
    const beta = await loaded({ location: "/work/beta", caller: BETA.id, storage, sessions: [BETA] })

    alpha.host.emit("session.created", { sessionID: SIBLING.id })
    await settle()
    await beta.host.call("peers", { action: "list" })

    const here = await alpha.host.call("peers", { action: "list-cwd" })
    expect(here.text).toBe(
      [
        "**Other sessions (cwd: /work/alpha):**",
        "• Sibling work (ses_ssss) — /work/alpha (idle)",
      ].join("\n"),
    )
    expect(here.details).toEqual({
      roster: {
        peers: [{ ...peerDetails(SIBLING, "/work/alpha", "idle"), self: false }],
        total: 1,
        cwd: "/work/alpha",
      },
    })

    const elsewhere = await beta.host.call("peers", { action: "list-cwd" })
    expect(elsewhere.text).toBe("No other sessions in this directory.")
    expect(elsewhere.details).toMatchObject({ roster: { peers: [], total: 0, cwd: "/work/beta" } })

    await alpha.unload()
    await beta.unload()
  })
})

describe("the heartbeat", () => {
  test("keeps a served session on the roster past the TTL", async () => {
    const storage = fakeStorage()
    const ttl = 400
    const alpha = await loaded({
      location: "/work/alpha",
      caller: ALPHA.id,
      storage,
      options: { rosterTtlMs: ttl },
      sessions: [ALPHA],
    })
    const beta = await loaded({
      location: "/work/beta",
      caller: BETA.id,
      storage,
      options: { rosterTtlMs: ttl },
      sessions: [BETA],
    })

    // Beta is published once, then nothing but its heartbeat happens.
    await beta.host.call("peers", { action: "list" })
    await Bun.sleep(ttl + 100)
    expect(peerRecords(storage).some((peer) => peer.sessionID === BETA.id)).toBe(true)

    const result = await alpha.host.call("peers", { action: "list" })
    expect(result.text).toContain("Docs site")

    await alpha.unload()
    await beta.unload()
  })
})

describe("seeding from storage", () => {
  test("a fresh instance adopts its predecessor's records for this directory", async () => {
    const storage = fakeStorage()
    const before = Date.now() - 1_000
    await storage.set(
      peerKey(ALPHA.id),
      peerRecord({
        sessionID: ALPHA.id,
        title: "Payments API",
        directory: "/work/alpha",
        instanceID: "instance-before",
        updatedAt: before,
      }),
    )
    await storage.set(
      peerKey(BETA.id),
      peerRecord({
        sessionID: BETA.id,
        title: "Docs site",
        directory: "/work/beta",
        instanceID: "instance-other",
        updatedAt: before,
      }),
    )

    const alpha = await loaded({ location: "/work/alpha", caller: ALPHA.id, storage, sessions: [ALPHA] })

    const records = peerRecords(storage)
    expect(records.find((peer) => peer.sessionID === ALPHA.id)?.instanceID).not.toBe("instance-before")
    expect(records.find((peer) => peer.sessionID === ALPHA.id)?.updatedAt).toBeGreaterThan(before)
    // Another directory's record is not this instance's to refresh.
    expect(records.find((peer) => peer.sessionID === BETA.id)?.instanceID).toBe("instance-other")

    await alpha.unload()
  })
})

describe("a disabled plugin", () => {
  test("publishes nothing and tells the session why", async () => {
    const storage = fakeStorage()
    const alpha = await loaded({
      location: "/work/alpha",
      caller: ALPHA.id,
      storage,
      options: { enabled: false },
      sessions: [ALPHA],
    })

    const result = await alpha.host.call("peers", { action: "list" })
    expect(result.text).toBe("Session peers is disabled by configuration.")
    expect(result.details).toMatchObject({ code: "E_DISABLED" })
    expect(storage.values()).toEqual([])

    await alpha.unload()
  })
})

describe("when a location's instance is replaced", () => {
  test("stops its own subscription, and leaves its records for whoever takes over", async () => {
    const storage = fakeStorage()
    const alpha = await loaded({ location: "/work/alpha", caller: ALPHA.id, storage, sessions: [ALPHA] })
    const beta = await loaded({ location: "/work/beta", caller: BETA.id, storage, sessions: [BETA] })

    await alpha.host.call("peers", { action: "list" })
    await beta.host.call("peers", { action: "list" })
    expect(peerRecords(storage)).toHaveLength(2)

    await alpha.unload()

    // Alpha's row is deliberately still there: withdrawing it would take every
    // idle session in that location off the roster until it ran something.
    expect(peerRecords(storage).map((peer) => peer.sessionID).sort()).toEqual([ALPHA.id, BETA.id])
    expect(alpha.host.subscribers()).toBe(0)
    expect(beta.host.subscribers()).toBe(1)

    await beta.unload()
  })

  test("publishes an idle session again under the successor, without it doing anything", async () => {
    const storage = fakeStorage()
    const first = await loaded({ location: "/work/alpha", caller: ALPHA.id, storage, sessions: [ALPHA] })
    await first.host.call("peers", { action: "list" })
    const before = peerRecords(storage).find((peer) => peer.sessionID === ALPHA.id)
    expect(before).toBeDefined()
    const firstInstance = before?.instanceID

    await first.unload()

    // The same location comes back. Nothing happens in the session itself.
    const second = await loaded({ location: "/work/alpha", caller: ALPHA.id, storage, sessions: [ALPHA] })
    await settle()

    const after = peerRecords(storage).find((peer) => peer.sessionID === ALPHA.id)
    expect(after).toBeDefined()
    expect(after?.instanceID).not.toBe(firstInstance)

    const result = await second.host.call("peers", { action: "list" })
    expect(result.text).toContain("/work/alpha")

    await second.unload()
  })

  test("leaves a record whose session is gone for the sweep, rather than republishing it", async () => {
    const storage = fakeStorage()
    const ghost = peerRecord({
      sessionID: "ses_ghost",
      directory: "/work/alpha",
      updatedAt: Date.now() - 5_000,
    })
    await storage.set(peerKey(ghost.sessionID), ghost)

    const alpha = await loaded({ location: "/work/alpha", caller: ALPHA.id, storage, sessions: [ALPHA] })
    await settle()

    expect(peerRecords(storage).find((peer) => peer.sessionID === ghost.sessionID)?.updatedAt).toBe(
      ghost.updatedAt,
    )

    await alpha.unload()
  })
})
