/**
 * Reclaiming what nobody owns.
 *
 * Two levels, both observable: the domain rule's boundary, and what a sweep
 * actually removes from the shared storage — including the race the sweep
 * exists to survive, a record refreshed between the scan and the removal.
 */

import { describe, expect, test } from "bun:test"

import { DEFAULT_CONFIG } from "../src/config.ts"
import { RECLAIM_MARGIN, reclaimable } from "../src/domain/reclaim.ts"
import type { AskRecord, Peer, ReplyRecord } from "../src/domain/types.ts"
import plugin from "../src/index.ts"
import { reclaimStale } from "../src/peers/reclaim.ts"
import { fakeHost, fakePluginStorage, fakeStorage, type FakeStorage } from "./fake-host.ts"

const TTL = DEFAULT_CONFIG.rosterTtlMs
const NOW = 1_000_000_000_000
const ASK_LIFETIME = 60_000

function peer(sessionID: string, updatedAt: number): Peer {
  return {
    sessionID,
    title: sessionID,
    directory: "/tmp/opencode/fake",
    scope: "default",
    instanceID: "instance-1",
    updatedAt,
  }
}

function ask(askID: string, createdAt: number, expiresAt: number): AskRecord {
  return {
    askID,
    askerSessionID: "ses_asker",
    askerInstanceID: "instance-1",
    askerTitle: "Asker",
    targetSessionID: "ses_target",
    question: "are you there?",
    createdAt,
    expiresAt,
  }
}

describe("the reclaim rule", () => {
  test("leaves a record alone however long ago it expired, up to the margin", () => {
    expect(reclaimable(NOW - 1, NOW, TTL)).toBe(false)
    expect(reclaimable(NOW - TTL, NOW, TTL)).toBe(false)
    expect(reclaimable(NOW - TTL * RECLAIM_MARGIN, NOW, TTL)).toBe(false)
  })

  test("reclaims a record that is expired by more than its margin", () => {
    expect(reclaimable(NOW - TTL * RECLAIM_MARGIN - 1, NOW, TTL)).toBe(true)
  })
})

describe("a sweep of the shared storage", () => {
  test("reclaims what died uncleanly and keeps what is merely quiet", async () => {
    const storage = fakePluginStorage(fakeStorage())
    await storage.peers.write("ses_dead", peer("ses_dead", NOW - TTL * (RECLAIM_MARGIN + 2)))
    await storage.peers.write("ses_quiet", peer("ses_quiet", NOW - TTL * 2))
    await storage.peers.write("ses_live", peer("ses_live", NOW - 5))

    const report = await reclaimStale({ storage, config: DEFAULT_CONFIG, now: NOW })

    expect(report).toEqual({ reclaimed: 1, failures: 0 })
    expect((await storage.peers.list()).map((record) => record.id)).toEqual(["ses_live", "ses_quiet"])
  })

  test("keeps a record whose writer refreshed it after the scan", async () => {
    const inner = fakeStorage()
    await fakePluginStorage(inner).peers.write("ses_racy", peer("ses_racy", NOW - TTL * (RECLAIM_MARGIN + 2)))
    // The real race: a writer publishes a fresh row between our scan and our
    // removal. The reader below stands in for it.
    const raced = {
      ...inner,
      async get(key: string) {
        return key.endsWith("ses_racy") ? peer("ses_racy", NOW) : inner.get(key)
      },
    } as FakeStorage

    const report = await reclaimStale({ storage: fakePluginStorage(raced), config: DEFAULT_CONFIG, now: NOW })

    expect(report.reclaimed).toBe(0)
    expect((await fakePluginStorage(inner).peers.list()).map((record) => record.id)).toEqual(["ses_racy"])
  })

  test("reclaims an old question and the reply slot beside it, and leaves a live one alone", async () => {
    const storage = fakePluginStorage(fakeStorage())
    await storage.asks.write("ask-old", ask("ask-old", NOW - 100 * ASK_LIFETIME, NOW - 99 * ASK_LIFETIME))
    const orphan: ReplyRecord = { askID: "ask-old", fromSessionID: "ses_target", fromTitle: "Target", text: "too late" }
    await storage.replies.write("ask-old", orphan)
    await storage.asks.write("ask-live", ask("ask-live", NOW, NOW + ASK_LIFETIME))

    const report = await reclaimStale({ storage, config: DEFAULT_CONFIG, now: NOW })

    expect(report).toEqual({ reclaimed: 1, failures: 0 })
    expect((await storage.asks.list()).map((record) => record.id)).toEqual(["ask-live"])
    expect(await storage.replies.read("ask-old")).toBeUndefined()
  })

  test("counts a removal that fails instead of failing the sweep", async () => {
    const inner = fakeStorage()
    await fakePluginStorage(inner).peers.write("ses_dead", peer("ses_dead", NOW - TTL * (RECLAIM_MARGIN + 2)))
    const refusing = {
      ...inner,
      async remove() {
        throw new Error("storage refused the write")
      },
    } as FakeStorage

    const report = await reclaimStale({ storage: fakePluginStorage(refusing), config: DEFAULT_CONFIG, now: NOW })

    expect(report).toEqual({ reclaimed: 0, failures: 1 })
  })
})

describe("the roster sweeps when it starts", () => {
  test("a row left by an instance that died uncleanly is gone once the plugin is loaded", async () => {
    const storage = fakeStorage()
    await fakePluginStorage(storage).peers.write(
      "ses_dead",
      peer("ses_dead", Date.now() - TTL * (RECLAIM_MARGIN + 2)),
    )

    const host = fakeHost({ storage })
    await plugin.setup(host.context)

    expect((await fakePluginStorage(storage).peers.list()).map((record) => record.id)).not.toContain("ses_dead")
  })
})
