import { describe, expect, test } from "bun:test"

import {
  CORRECTION_UNAVAILABLE_REASON,
  MANUAL_CORRECTION_UNAVAILABLE_REASON,
  RECOVERY_UNAVAILABLE_REASON,
  SAFETY_PAUSE_UNAVAILABLE_REASON,
} from "../src/domain/watch.ts"
import { watchCapability, watchControls } from "../src/watch/view.ts"
import { readWatchCapabilityView } from "../src/watch/contract.ts"

describe("watch capability text", () => {
  test("direct-child support is not a grant or a verified correction runtime", () => {
    const capability = watchCapability()
    expect(capability.delegation).toBe("direct-child")
    expect(capability.delegationReason).toContain("controlled")
    expect(capability.delegationReason).toContain("parentID")
    expect(capability.delegationReason).toContain("scope")
    expect(capability.delegationReason).toContain("does not grant")
    expect(capability.correction).toBe("unavailable")
    expect(readWatchCapabilityView(capability)).toEqual(capability)
    expect(readWatchCapabilityView({ ...capability, delegation: "all-descendants" })).toBeUndefined()
    expect(readWatchCapabilityView({ ...capability, delegation: "unavailable" })?.delegation).toBe("unavailable")
  })

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
