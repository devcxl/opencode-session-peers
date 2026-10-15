/**
 * What the `handover` action needs from the host, gathered in one place.
 *
 * A handover touches three host facilities — the session's own model, the
 * version control surface, and the directory this instance serves — and the
 * action should not have to know how each was obtained. The entry point builds
 * this from the host port, as it does for the other actions.
 */

import type { InstanceLocation } from "./index.ts"
import type { Generation } from "./generation.ts"
import type { VersionControl } from "./vcs.ts"

export interface HandoverSupport {
  readonly generation: Generation
  readonly versionControl: VersionControl
  /** The directory the sending session works in: one plugin instance serves one. */
  readonly senderDirectory: InstanceLocation["directory"]
}
