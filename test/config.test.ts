import { describe, expect, test } from "bun:test"

import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts"

describe("parseConfig", () => {
  test("no options yields the documented defaults", () => {
    const { config, warnings } = parseConfig(undefined)
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(warnings).toEqual([])
  })

  test("an empty object yields the defaults", () => {
    expect(parseConfig({})).toEqual({ config: DEFAULT_CONFIG, warnings: [] })
  })

  test("valid options are applied verbatim", () => {
    const { config, warnings } = parseConfig({
      enabled: false,
      scope: "team-a",
      replyHint: false,
      askTimeoutMs: 1_000,
      rosterTtlMs: 5_000,
      trigger: "replies",
      busyDelivery: "queue",
    })
    expect(config).toEqual({
      enabled: false,
      scope: "team-a",
      replyHint: false,
      askTimeoutMs: 1_000,
      rosterTtlMs: 5_000,
      inbound: { trigger: "replies", busyDelivery: "queue" },
    })
    expect(warnings).toEqual([])
  })

  test("an unknown trigger fails closed to never, not to the permissive default", () => {
    const { config, warnings } = parseConfig({ trigger: "sometimes" })
    expect(config.inbound.trigger).toBe("never")
    expect(warnings).toHaveLength(1)
  })

  test("an unknown busy delivery falls back to the default and is reported", () => {
    const { config, warnings } = parseConfig({ busyDelivery: "interrupt" })
    expect(config.inbound.busyDelivery).toBe(DEFAULT_CONFIG.inbound.busyDelivery)
    expect(warnings).toHaveLength(1)
  })

  test("a timeout that is not a positive integer falls back and is reported", () => {
    expect(parseConfig({ askTimeoutMs: -1 }).config.askTimeoutMs).toBe(DEFAULT_CONFIG.askTimeoutMs)
    expect(parseConfig({ askTimeoutMs: 1.5 }).config.askTimeoutMs).toBe(DEFAULT_CONFIG.askTimeoutMs)
    expect(parseConfig({ askTimeoutMs: "60000" }).warnings).toHaveLength(1)
  })

  test("a blank scope falls back and is reported", () => {
    const { config, warnings } = parseConfig({ scope: "   " })
    expect(config.scope).toBe(DEFAULT_CONFIG.scope)
    expect(warnings).toHaveLength(1)
  })

  test("options that are not an object are ignored, and turns stay off", () => {
    const { config, warnings } = parseConfig("nope")
    expect(config.inbound).toEqual({ ...DEFAULT_CONFIG.inbound, trigger: "never" })
    expect(warnings).toHaveLength(1)
  })

  test("a non-boolean switch is reported and keeps its default", () => {
    const { config, warnings } = parseConfig({ enabled: "yes" })
    expect(config.enabled).toBe(DEFAULT_CONFIG.enabled)
    expect(warnings).toHaveLength(1)
  })
})
