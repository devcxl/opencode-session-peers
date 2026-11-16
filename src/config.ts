/**
 * Plugin options.
 *
 * Options arrive from opencode's config as `{ package, options }`. Anything
 * unexpected is a user error, so a bad value is replaced by a safe one and
 * reported once at load — never at call time. `trigger` fails closed to
 * `"never"`: a misconfigured plugin must not start turns in other people's
 * sessions.
 */

import type { InboundPolicy } from "./domain/policy.ts"
import type { Delivery } from "./domain/types.ts"

export interface WatchConfig {
  /** Continuous trusted idle before an idle alert is formed. */
  idleMs: number
  /** Running without target activity before the initiator is alerted. */
  runningSilentMs: number
  /** A wait without an earlier deadline may be alerted after this long. */
  waitOverdueMs: number
  /** Observation sampling interval. */
  tickMs: number
  /** Observation after one automatic attempt before another may be considered. */
  correctionObservationMs: number
  /** Fixed budget of one continuous problem, measured from its first attempt. */
  correctionWindowMs: number
}

export interface Config {
  enabled: boolean
  /** Visibility partition. Peers only resolve within their own scope. */
  scope: string
  inbound: InboundPolicy
  /** Append the reply instruction to an inbound question. */
  replyHint: boolean
  askTimeoutMs: number
  /** A roster record older than this belongs to a session that has gone away. */
  rosterTtlMs: number
  /** Bounded watchdog observation windows; these are engineering initial values. */
  watch: WatchConfig
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  scope: "default",
  inbound: { trigger: "always", busyDelivery: "steer" },
  replyHint: true,
  askTimeoutMs: 10 * 60 * 1000,
  rosterTtlMs: 90 * 1000,
  watch: {
    idleMs: 2 * 60 * 1000,
    runningSilentMs: 10 * 60 * 1000,
    waitOverdueMs: 30 * 60 * 1000,
    tickMs: 15 * 1000,
    correctionObservationMs: 5 * 60 * 1000,
    correctionWindowMs: 20 * 60 * 1000,
  },
}

export interface ConfigParse {
  config: Config
  /** Why an option was ignored. Surface once, at load. */
  warnings: readonly string[]
}

export function parseConfig(raw: unknown): ConfigParse {
  const warnings: string[] = []
  const config: Config = { ...DEFAULT_CONFIG, inbound: { ...DEFAULT_CONFIG.inbound } }

  if (raw === undefined || raw === null) return { config, warnings }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    config.inbound.trigger = "never"
    warnings.push("plugin options must be an object; ignoring them")
    return { config, warnings }
  }

  const options = raw as Record<string, unknown>
  config.enabled = booleanOption(options, "enabled", DEFAULT_CONFIG.enabled, warnings)
  config.replyHint = booleanOption(options, "replyHint", DEFAULT_CONFIG.replyHint, warnings)
  config.scope = nonEmptyStringOption(options, "scope", DEFAULT_CONFIG.scope, warnings)
  config.askTimeoutMs = positiveIntegerOption(options, "askTimeoutMs", DEFAULT_CONFIG.askTimeoutMs, warnings)
  config.rosterTtlMs = positiveIntegerOption(options, "rosterTtlMs", DEFAULT_CONFIG.rosterTtlMs, warnings)
  config.inbound.trigger = triggerOption(options, warnings)
  config.inbound.busyDelivery = deliveryOption(options, warnings)
  config.watch = watchOptions(options["watch"], warnings)

  return { config, warnings }
}

function booleanOption(
  options: Record<string, unknown>,
  key: string,
  fallback: boolean,
  warnings: string[],
): boolean {
  const value = options[key]
  if (value === undefined) return fallback
  if (typeof value === "boolean") return value
  warnings.push(`"${key}" must be a boolean; using ${String(fallback)}`)
  return fallback
}

function nonEmptyStringOption(
  options: Record<string, unknown>,
  key: string,
  fallback: string,
  warnings: string[],
): string {
  const value = options[key]
  if (value === undefined) return fallback
  if (typeof value === "string" && value.trim().length > 0) return value.trim()
  warnings.push(`"${key}" must be a non-empty string; using ${JSON.stringify(fallback)}`)
  return fallback
}

function positiveIntegerOption(
  options: Record<string, unknown>,
  key: string,
  fallback: number,
  warnings: string[],
): number {
  const value = options[key]
  if (value === undefined) return fallback
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
  warnings.push(`"${key}" must be a positive integer; using ${String(fallback)}`)
  return fallback
}

function triggerOption(options: Record<string, unknown>, warnings: string[]): InboundPolicy["trigger"] {
  const value = options["trigger"]
  if (value === undefined) return DEFAULT_CONFIG.inbound.trigger
  if (value === "always" || value === "replies" || value === "never") return value
  warnings.push(`"trigger" must be one of always, replies, never; using "never"`)
  return "never"
}

function watchOptions(raw: unknown, warnings: string[]): WatchConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_CONFIG.watch }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`"watch" must be an object; using defaults`)
    return { ...DEFAULT_CONFIG.watch }
  }
  const options = raw as Record<string, unknown>
  return {
    idleMs: boundedIntegerOption(
      options,
      "idleMs",
      DEFAULT_CONFIG.watch.idleMs,
      1_000,
      30 * 60_000,
      "watch.idleMs",
      warnings,
    ),
    runningSilentMs: boundedIntegerOption(
      options,
      "runningSilentMs",
      DEFAULT_CONFIG.watch.runningSilentMs,
      5_000,
      60 * 60_000,
      "watch.runningSilentMs",
      warnings,
    ),
    waitOverdueMs: boundedIntegerOption(
      options,
      "waitOverdueMs",
      DEFAULT_CONFIG.watch.waitOverdueMs,
      60_000,
      2 * 60 * 60_000,
      "watch.waitOverdueMs",
      warnings,
    ),
    tickMs: boundedIntegerOption(
      options,
      "tickMs",
      DEFAULT_CONFIG.watch.tickMs,
      250,
      60_000,
      "watch.tickMs",
      warnings,
    ),
    correctionObservationMs: boundedIntegerOption(
      options,
      "correctionObservationMs",
      DEFAULT_CONFIG.watch.correctionObservationMs,
      5 * 60_000,
      60 * 60_000,
      "watch.correctionObservationMs",
      warnings,
    ),
    correctionWindowMs: boundedIntegerOption(
      options,
      "correctionWindowMs",
      DEFAULT_CONFIG.watch.correctionWindowMs,
      5 * 60_000,
      2 * 60 * 60_000,
      "watch.correctionWindowMs",
      warnings,
    ),
  }
}

function boundedIntegerOption(
  options: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
  warnings: string[],
): number {
  const value = options[key]
  if (value === undefined) return fallback
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  ) {
    return value
  }
  warnings.push(`"${label}" must be an integer between ${minimum} and ${maximum}; using ${fallback}`)
  return fallback
}

function deliveryOption(options: Record<string, unknown>, warnings: string[]): Delivery {
  const value = options["busyDelivery"]
  if (value === undefined) return DEFAULT_CONFIG.inbound.busyDelivery
  if (value === "steer" || value === "queue") return value
  warnings.push(`"busyDelivery" must be "steer" or "queue"; using "${DEFAULT_CONFIG.inbound.busyDelivery}"`)
  return DEFAULT_CONFIG.inbound.busyDelivery
}
