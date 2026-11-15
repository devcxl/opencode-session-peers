/**
 * Small formatting helpers shared by the watch panel's task and alert views.
 *
 * These are deliberately data-driven: thresholds are formatted from the
 * answer's effective values, never from the defaults this build ships.
 */

import type { TableCell, Tone } from "./view.ts"

export function cell(text: string, tone: Tone): TableCell {
  return { text, tone }
}

export function fact(label: string, value: string): readonly TableCell[] {
  return [cell(label, "muted"), cell(value, "base")]
}

export function join(...parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join(" · ")
}

export function ensurePeriod(text: string): string {
  const trimmed = text.trim()
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`
}

/** Timestamps are UTC and stable in tests: the same value in every timezone. */
export function formatWatchTime(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return "unknown time"
  return `${date.toISOString().slice(0, 19).replace("T", " ")}Z`
}

/** A configured window, shown as the server supplied it. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "unknown"
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms >= 60_000) {
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.round((ms % 60_000) / 1_000)
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  }
  if (ms % 1_000 === 0) return `${ms / 1_000}s`
  return `${ms}ms`
}
