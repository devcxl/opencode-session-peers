import { describe, expect, test } from "bun:test"

import { resolvePeer } from "../src/domain/addressing.ts"
import type { Peer } from "../src/domain/types.ts"

function peer(sessionID: string, title: string, overrides: Partial<Peer> = {}): Peer {
  return {
    sessionID,
    title,
    directory: "/tmp/work",
    scope: "default",
    instanceID: "instance-a",
    updatedAt: 0,
    ...overrides,
  }
}

const SELF = "ses_self000000000000"

describe("resolvePeer", () => {
  test("resolves an exact session id", () => {
    const target = peer("ses_aaaaaaaaaaaa1111", "Payments API")
    const result = resolvePeer(target.sessionID, [target], SELF)
    expect(result).toEqual({ kind: "resolved", peer: target, matchedBy: "id" })
  })

  test("resolves a title case-insensitively", () => {
    const target = peer("ses_aaaaaaaaaaaa1111", "Payments API")
    const result = resolvePeer("payments api", [target], SELF)
    expect(result).toEqual({ kind: "resolved", peer: target, matchedBy: "title" })
  })

  test("resolves a unique id prefix", () => {
    const target = peer("ses_aaaaaaaaaaaa1111", "Payments API")
    const other = peer("ses_bbbbbbbbbbbb2222", "Ops console")
    const result = resolvePeer("ses_aaaa", [target, other], SELF)
    expect(result).toEqual({ kind: "resolved", peer: target, matchedBy: "id-prefix" })
  })

  test("prefers an id match over a title match", () => {
    const byID = peer("ses_aaaaaaaaaaaa1111", "one")
    const byTitle = peer("ses_bbbbbbbbbbbb2222", "ses_aaaaaaaaaaaa1111")
    const result = resolvePeer("ses_aaaaaaaaaaaa1111", [byID, byTitle], SELF)
    expect(result.kind).toBe("resolved")
    expect(result.kind === "resolved" && result.peer).toBe(byID)
  })

  test("fails closed when a title matches more than one peer", () => {
    const first = peer("ses_aaaaaaaaaaaa1111", "Payments API")
    const second = peer("ses_bbbbbbbbbbbb2222", "payments api")
    const result = resolvePeer("Payments API", [first, second], SELF)
    expect(result).toEqual({ kind: "ambiguous", candidates: [first, second] })
  })

  test("fails closed when a prefix matches more than one peer", () => {
    const first = peer("ses_aaaaaaaaaaaa1111", "one")
    const second = peer("ses_aaaaaaaaaaaa2222", "two")
    const result = resolvePeer("ses_aaaa", [first, second], SELF)
    expect(result.kind).toBe("ambiguous")
  })

  test("recognises the caller's own session id", () => {
    expect(resolvePeer(SELF, [], SELF)).toEqual({ kind: "self" })
  })

  test("treats an unknown target and a blank target as not found", () => {
    expect(resolvePeer("nowhere", [peer("ses_aaaaaaaaaaaa1111", "one")], SELF)).toEqual({ kind: "not-found" })
    expect(resolvePeer("   ", [], SELF)).toEqual({ kind: "not-found" })
  })
})
