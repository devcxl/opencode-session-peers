/**
 * The RPC surface, driven through a fake host.
 *
 * Same seam as the entry tests: `setup` is handed a fake context, and what is
 * asserted is the payload a TUI side would receive — validated against the
 * definition's own output schema the way the host validates it — plus the
 * `changed` events the view relies on. Never how the plugin is wired inside.
 */

import { describe, expect, test } from "bun:test"

import type { Peer } from "../src/domain/types.ts"
import { peerKey } from "../src/host/storage.ts"
import plugin from "../src/index.ts"
import { readRosterPayload, SESSION_PEERS_RPC_ID } from "../src/rpc.ts"
import type { RosterPayload } from "../src/rpc.ts"
import { fakeHost, type FakeHostOptions } from "./fake-host.ts"
import { fakeStorage } from "./fake-storage.ts"

/** Load the plugin into a fake host, as the host would, and keep the unload. */
async function loaded(options: FakeHostOptions = {}) {
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

/** Ask the one registered surface for the roster, as a client would. */
async function readRoster(host: Awaited<ReturnType<typeof loaded>>["host"]): Promise<RosterPayload> {
  const rpc = host.rpcs[0]
  if (rpc === undefined) throw new Error("the plugin registered no RPC surface")
  const answer = await rpc.call("roster", {})
  const payload = readRosterPayload(answer)
  if (payload === undefined) throw new Error(`the answer is not a roster: ${JSON.stringify(answer)}`)
  return payload
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

const ALPHA = { id: "ses_aaaa1111", title: "Payments API" }
const BETA = { id: "ses_bbbb2222", title: "Docs site" }
const SIBLING = { id: "ses_ssss1111", title: "Sibling work" }

describe("the registered surface", () => {
  test("is versioned, and answers one method", async () => {
    const { host, unload } = await loaded()
    expect(host.rpcs).toHaveLength(1)
    expect(host.rpcs[0]?.id).toBe(SESSION_PEERS_RPC_ID)
    expect(host.rpcs[0]?.methods).toEqual(["roster"])
    await unload()
  })

  test("disposes its registration when the plugin unloads", async () => {
    const { host, unload } = await loaded()
    expect(host.rpcs[0]?.disposed).toBe(false)
    await unload()
    expect(host.rpcs[0]?.disposed).toBe(true)
  })
})

describe("the roster answer", () => {
  test("names the scope and the TTL the rows were filtered by", async () => {
    const { host, unload } = await loaded({ options: { scope: "team-a", rosterTtlMs: 12_000 } })
    const payload = await readRoster(host)
    expect(payload).toMatchObject({ enabled: true, scope: "team-a", rosterTtlMs: 12_000 })
    await unload()
  })

  test("carries exactly the peers the list action resolves, in its order", async () => {
    const storage = fakeStorage()
    const alpha = await loaded({ location: "/work/alpha", caller: ALPHA.id, storage, sessions: [ALPHA] })
    const beta = await loaded({ location: "/work/beta", caller: BETA.id, storage, sessions: [BETA] })

    await beta.host.call("peers", { action: "list" })
    const afterBoth = await alpha.host.call("peers", { action: "list" })
    const payload = await readRoster(alpha.host)

    // The tool's own listing, once both are on the roster: same sessions, same
    // order, as the text the model reads.
    expect(afterBoth.text.indexOf("Payments API")).toBeLessThan(afterBoth.text.indexOf("Docs site"))
    expect(payload.peers.map((peer) => peer.sessionID)).toEqual(["ses_aaaa1111", "ses_bbbb2222"])
    expect(payload.peers[0]).toEqual({
      sessionID: ALPHA.id,
      title: "Payments API",
      directory: "/work/alpha",
      status: null,
      statusReason: "not seen running since this instance started",
    })

    await alpha.unload()
    await beta.unload()
  })

  test("never reports a status it does not have as idle", async () => {
    const storage = fakeStorage()
    // A predecessor's record: the session is in this directory, but this
    // instance has not seen it run since it started.
    await storage.set(
      peerKey(SIBLING.id),
      peerRecord({ sessionID: SIBLING.id, title: "Sibling work", directory: "/work/alpha" }),
    )
    const alpha = await loaded({
      location: "/work/alpha",
      caller: ALPHA.id,
      storage,
      sessions: [ALPHA, SIBLING],
    })

    const adopted = await readRoster(alpha.host)
    const sibling = adopted.peers.find((peer) => peer.sessionID === SIBLING.id)
    expect(sibling).toMatchObject({
      status: null,
      statusReason: "not seen running since this instance started",
    })

    // Once the host says what the session is doing, that is the status.
    alpha.host.emit("session.created", { sessionID: SIBLING.id })
    await settle()
    const seen = await readRoster(alpha.host)
    expect(seen.peers.find((peer) => peer.sessionID === SIBLING.id)).toMatchObject({
      status: "idle",
      statusReason: null,
    })

    await alpha.unload()
  })

  test("a peer in another scope is not a row, and is counted as elsewhere", async () => {
    const storage = fakeStorage()
    await storage.set(
      peerKey("ses_dddd4444"),
      peerRecord({ sessionID: "ses_dddd4444", title: "Other team", scope: "team-b" }),
    )
    const alpha = await loaded({ location: "/work/alpha", caller: ALPHA.id, storage, sessions: [ALPHA] })

    const payload = await readRoster(alpha.host)
    expect(payload.peers).toEqual([])
    expect(payload.liveInOtherScopes).toBe(1)
    expect(payload.quietInScope).toBe(0)

    await alpha.unload()
  })

  test("a peer whose heartbeats stopped is not a row, and is counted as quiet", async () => {
    const storage = fakeStorage()
    const ttl = 5_000
    await storage.set(
      peerKey("ses_dddd4444"),
      peerRecord({
        sessionID: "ses_dddd4444",
        title: "Gone quiet",
        directory: "/work/alpha",
        updatedAt: Date.now() - ttl - 1,
      }),
    )
    const alpha = await loaded({
      location: "/work/alpha",
      caller: ALPHA.id,
      storage,
      options: { rosterTtlMs: ttl },
      sessions: [ALPHA],
    })

    const payload = await readRoster(alpha.host)
    expect(payload.peers.map((peer) => peer.title)).not.toContain("Gone quiet")
    expect(payload.quietInScope).toBe(1)
    expect(payload.liveInOtherScopes).toBe(0)

    await alpha.unload()
  })

  test("a disabled plugin still answers, saying it is off", async () => {
    const storage = fakeStorage()
    const alpha = await loaded({
      location: "/work/alpha",
      caller: ALPHA.id,
      storage,
      options: { enabled: false },
      sessions: [ALPHA],
    })

    const payload = await readRoster(alpha.host)
    expect(payload).toEqual({
      enabled: false,
      scope: "default",
      rosterTtlMs: 90_000,
      peers: [],
      quietInScope: 0,
      liveInOtherScopes: 0,
    })
    // Off means off: it published nothing of its own either.
    expect(storage.values()).toEqual([])

    await alpha.unload()
  })
})

describe("announcing changes", () => {
  test("a session the host announces reaches the surface and fires changed", async () => {
    const storage = fakeStorage()
    const alpha = await loaded({
      location: "/work/alpha",
      caller: ALPHA.id,
      storage,
      sessions: [ALPHA, SIBLING],
    })
    const before = (await readRoster(alpha.host)).peers.map((peer) => peer.sessionID)
    expect(before).not.toContain(SIBLING.id)

    alpha.host.emit("session.created", { sessionID: SIBLING.id })
    await settle()

    const after = await readRoster(alpha.host)
    expect(after.peers.map((peer) => peer.sessionID)).toContain(SIBLING.id)
    expect(alpha.host.rpcs[0]?.events.map((event) => event.name)).toEqual(["changed"])

    await alpha.unload()
  })

  test("a row changing is announced, a heartbeat refreshing it is not", async () => {
    const storage = fakeStorage()
    const alpha = await loaded({
      location: "/work/alpha",
      caller: ALPHA.id,
      storage,
      options: { rosterTtlMs: 3_000 },
      sessions: [ALPHA, SIBLING],
    })

    alpha.host.emit("session.created", { sessionID: SIBLING.id })
    alpha.host.emit("session.execution.started", { sessionID: SIBLING.id })
    await settle()
    const announced = alpha.host.rpcs[0]?.events.length ?? 0
    expect(announced).toBeGreaterThan(0)

    // Beats refresh the same row over and over: a row that still reads the same
    // is not news, so nothing more is announced.
    await Bun.sleep(3_200)
    expect(alpha.host.rpcs[0]?.events.length).toBe(announced)

    // A peer that appears in the shared storage is news even though this
    // instance sees no event for it: a location that is not this one writes it.
    await storage.set(
      peerKey(BETA.id),
      peerRecord({ sessionID: BETA.id, title: "Docs site", directory: "/work/beta" }),
    )
    await Bun.sleep(1_200)
    expect(alpha.host.rpcs[0]?.events.length).toBeGreaterThan(announced)
    const payload = await readRoster(alpha.host)
    expect(payload.peers.map((peer) => peer.sessionID)).toContain(BETA.id)

    await alpha.unload()
  })

  test("a peer going quiet is announced within a beat", async () => {
    const storage = fakeStorage()
    const ttl = 600
    const alpha = await loaded({
      location: "/work/alpha",
      caller: ALPHA.id,
      storage,
      options: { rosterTtlMs: ttl },
      sessions: [ALPHA],
    })
    const quiet = peerRecord({ sessionID: BETA.id, title: "Docs site", directory: "/work/beta" })
    await storage.set(peerKey(BETA.id), quiet)
    await Bun.sleep(ttl / 3 + 150)
    const announced = alpha.host.rpcs[0]?.events.length ?? 0
    expect((await readRoster(alpha.host)).peers.map((peer) => peer.sessionID)).toContain(BETA.id)

    // Its heartbeats stop, which no event here ever reports.
    await storage.set(peerKey(BETA.id), { ...quiet, updatedAt: Date.now() - ttl - 1 })
    await Bun.sleep(ttl / 3 + 150)

    expect(alpha.host.rpcs[0]?.events.length).toBeGreaterThan(announced)
    const payload = await readRoster(alpha.host)
    expect(payload.peers.map((peer) => peer.sessionID)).not.toContain(BETA.id)
    expect(payload.quietInScope).toBe(1)

    await alpha.unload()
  })
})

describe("the payload guard", () => {
  test("accepts what the surface answers", async () => {
    const alpha = await loaded({ caller: ALPHA.id })
    const rpc = alpha.host.rpcs[0]
    const answer = await rpc?.call("roster", {})
    const payload = readRosterPayload(answer)
    expect(payload).toBeDefined()
    // The whole answer, not just its head: the guard reads every field the
    // renderer touches.
    expect(payload).toEqual(answer as RosterPayload)
    await alpha.unload()
  })

  test("refuses anything that is not the shape the view renders", () => {
    expect(readRosterPayload(undefined)).toBeUndefined()
    expect(readRosterPayload("{}")).toBeUndefined()
    expect(readRosterPayload({})).toBeUndefined()
    expect(
      readRosterPayload({
        enabled: true,
        scope: "default",
        rosterTtlMs: 1,
        peers: [{ sessionID: "ses_x", title: "x", directory: "/x", status: 3, statusReason: null }],
        quietInScope: 0,
        liveInOtherScopes: 0,
      }),
    ).toBeUndefined()
    expect(
      readRosterPayload({
        enabled: true,
        scope: "default",
        rosterTtlMs: 1,
        peers: [{ sessionID: "ses_x", title: "x", directory: "/x", status: null }],
        quietInScope: 0,
        liveInOtherScopes: 0,
      }),
    ).toBeUndefined()
  })
})
