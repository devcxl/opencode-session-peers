/**
 * The fixtures the UI tests use must be answers `readWatchPayload` actually
 * accepts, and malformed observation/alert shapes must stay rejected. This
 * keeps the headless tests tied to the frozen wire contract instead of a
 * hand-written payload the plugin would never answer with.
 */

import { describe, expect, test } from "bun:test"

import { readWatchGrantPayload, readWatchPayload } from "../src/rpc.ts"
import {
  alert,
  alertsView,
  grantChallenge,
  grantPayload,
  observation,
  payload,
  wait,
} from "./tui-watch-fake.ts"

describe("the watch fixtures", () => {
  test("the shared payload is a valid WatchPayload", () => {
    expect(readWatchPayload(payload())).toBeDefined()
    expect(
      readWatchPayload(
        payload({
          alerts: alertsView([
            alert({ escalatedAt: Date.UTC(2026, 10, 16, 4, 36, 0) }),
          ]),
        }),
      ),
    ).toBeDefined()
    expect(
      readWatchPayload(
        payload({
          observation: observation({
            state: "normal-waiting",
            waits: [wait({ status: "overdue" })],
          }),
        }),
      ),
    ).toBeDefined()
  })

  test("the grant fixtures are valid WatchGrantPayloads and malformed challenges are rejected", () => {
    expect(readWatchGrantPayload(grantPayload())).toBeDefined()
    expect(
      readWatchGrantPayload(grantPayload({ challenge: grantChallenge() })),
    ).toBeDefined()

    const missingDigest: unknown = {
      ...grantPayload(),
      challenge: { ...grantChallenge(), termsDigest: undefined },
    }
    expect(readWatchGrantPayload(missingDigest)).toBeUndefined()

    const wrongDeployment: unknown = {
      ...grantPayload(),
      challenge: { ...grantChallenge(), deployment: "other" },
    }
    expect(readWatchGrantPayload(wrongDeployment)).toBeUndefined()
  })

  test("rejects unknown observation and activity enums", () => {
    const unknownState = {
      ...payload(),
      observation: { ...observation(), state: "mystery" },
    }
    expect(readWatchPayload(unknownState)).toBeUndefined()

    const wrongJudgement = {
      ...payload(),
      activity: { lastAt: 1, kind: "text", judgement: "progress" },
    }
    expect(readWatchPayload(wrongJudgement)).toBeUndefined()

    const missingObservation = { ...payload() } as Record<string, unknown>
    delete missingObservation["observation"]
    expect(readWatchPayload(missingObservation)).toBeUndefined()
  })

  test("rejects inconsistent alert counts and malformed alert items", () => {
    const badCounts = {
      ...payload(),
      alerts: { ...alertsView([]), unread: 2, total: 1 },
    }
    expect(readWatchPayload(badCounts)).toBeUndefined()

    const badKind: unknown = {
      ...payload(),
      alerts: {
        ...alertsView([]),
        items: [{ ...alert(), kind: "mystery" }],
        total: 1,
      },
    }
    expect(readWatchPayload(badKind)).toBeUndefined()

    const badWait: unknown = {
      ...payload(),
      observation: {
        ...observation(),
        waits: [{ ...wait(), status: "maybe" }],
      },
    }
    expect(readWatchPayload(badWait)).toBeUndefined()
  })
})
