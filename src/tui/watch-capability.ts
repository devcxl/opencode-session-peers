/**
 * The watch panel's mode/capability wording. The selected mode and the actual
 * capability are separate facts; the panel never derives one from the other.
 */

import type { WatchPayload } from "../rpc.ts"
import { ensurePeriod } from "./watch-format.ts"

export function authorizationText(mode: WatchPayload["capability"]["mode"]): string {
  return modeName(mode)
}

export function modeName(mode: WatchPayload["capability"]["mode"]): string {
  switch (mode) {
    case "alert":
      return "alert-only"
    case "limited-correction":
      return "limited correction"
  }
}

export function capabilityText(capability: WatchPayload["capability"]): string {
  const monitoring =
    capability.monitoring === "observer-alerts" ? "observer alerts" : capability.monitoring
  const automatic =
    capability.automaticDetection === "partial"
      ? "partial automatic detection"
      : `automatic detection ${capability.automaticDetection}`
  return `${monitoring}; ${automatic}`
}

export function capabilityNotes(payload: WatchPayload, compact: boolean): string[] {
  const notes: string[] = []
  const capability = payload.capability
  if (capability.automaticDetection === "partial") {
    notes.push(
      compact
        ? "Automatic detection: partial — local execution/activity/waits only."
        : `Automatic detection: partial — ${ensurePeriod(capability.automaticDetectionReason)}`,
    )
  }
  if (compact) return notes
  if (capability.correction === "unavailable") {
    notes.push(`Correction: unavailable — ${ensurePeriod(capability.correctionReason)}`)
  }
  if (capability.delegation === "unavailable") {
    notes.push(`Child-task enrollment: unavailable — ${ensurePeriod(capability.delegationReason)}`)
  }
  if (capability.transfer === "unavailable") {
    notes.push(`Ownership transfer: unavailable — ${ensurePeriod(capability.transferReason)}`)
  }
  if (capability.recovery === "unavailable") {
    notes.push(`Supervision resume: unavailable — ${ensurePeriod(capability.recoveryReason)}`)
  }
  if (capability.safetyPause === "unavailable") {
    notes.push(`Safety-pause recovery controls: unavailable — ${ensurePeriod(capability.safetyPauseReason)}`)
  }
  return notes
}
