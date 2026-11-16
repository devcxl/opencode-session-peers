import { describe, expect, test } from "bun:test"

import {
  CORRECTION_UNAVAILABLE_REASON,
  MANUAL_CORRECTION_UNAVAILABLE_REASON,
  RECOVERY_UNAVAILABLE_REASON,
  SAFETY_PAUSE_UNAVAILABLE_REASON,
} from "../src/domain/watch.ts"
import { watchCapability, watchControls } from "../src/watch/view.ts"

describe("watch capability text", () => {
  test("bounded correction is derived from the task gate, never from the selected mode", () => {
    const unavailable = watchCapability("limited-correction", "unavailable")
    const ready = watchCapability("limited-correction", "ready")
    expect(unavailable.correction).toBe("unavailable")
    expect(unavailable.correctionReason).toBe(CORRECTION_UNAVAILABLE_REASON)
    expect(unavailable.correctionReason).toContain("runtime/protocol")
    expect(ready.correction).toBe("bounded")
    expect(ready.correctionReason).toContain("up to three permanent automatic attempts")
    expect(ready.correctionReason).toContain("Manual correction")
    expect(watchCapability("alert", "ready").correction).toBe("bounded")
    expect(watchControls(null).correction).toMatchObject({
      enabled: false,
      reason: MANUAL_CORRECTION_UNAVAILABLE_REASON,
    })
  })

  test("recovery and safety pause reasons separate evidence from resume and takeover", () => {
    expect(RECOVERY_UNAVAILABLE_REASON).toContain("new result reference")
    expect(RECOVERY_UNAVAILABLE_REASON).toContain("does not resume")
    expect(SAFETY_PAUSE_UNAVAILABLE_REASON).toContain("displayed")
    expect(SAFETY_PAUSE_UNAVAILABLE_REASON).toContain("ownership takeover")
  })
})
