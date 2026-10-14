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

export interface Config {
  enabled: boolean
  /** Visibility partition. Peers only resolve within their own scope. */
  scope: string
  inbound: InboundPolicy
  /** Append the reply hint to inbound messages. */
  replyHint: boolean
  askTimeoutMs: number
  /** A roster record older than this belongs to a session that has gone away. */
  rosterTtlMs: number
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  scope: "default",
  inbound: { trigger: "always", busyDelivery: "steer" },
  replyHint: true,
  askTimeoutMs: 10 * 60 * 1000,
  rosterTtlMs: 90 * 1000,
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

function deliveryOption(options: Record<string, unknown>, warnings: string[]): Delivery {
  const value = options["busyDelivery"]
  if (value === undefined) return DEFAULT_CONFIG.inbound.busyDelivery
  if (value === "steer" || value === "queue") return value
  warnings.push(`"busyDelivery" must be "steer" or "queue"; using "${DEFAULT_CONFIG.inbound.busyDelivery}"`)
  return DEFAULT_CONFIG.inbound.busyDelivery
}
