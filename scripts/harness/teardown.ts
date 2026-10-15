/**
 * Teardown.
 *
 * It runs even when the run failed, and it is reported as an expectation of its
 * own: a run is green only when the instance stopped, its port closed, the
 * copied credentials are gone and the scratch directory is either removed or
 * kept on request.
 */

import { existsSync, rmSync } from "node:fs"
import type { HarnessOptions } from "./args.ts"
import type { InstanceHandle } from "./instance.ts"
import type { ScratchLayout } from "./paths.ts"
import { explain, type CleanupSummary } from "./report.ts"

export async function teardown(
  options: HarnessOptions,
  layout: ScratchLayout,
  instance: InstanceHandle | undefined,
  serviceJson: string,
): Promise<CleanupSummary> {
  const observations: string[] = []
  let processStopped = instance === undefined
  let portClosed = instance === undefined

  if (instance !== undefined) {
    const outcome = await instance.stop()
    processStopped = outcome.stopped
    portClosed = outcome.portClosed
    observations.push(`instance: ${outcome.observed}`)
  }

  let authFileRemoved = true
  try {
    if (existsSync(layout.authFile)) {
      rmSync(layout.authFile, { force: true })
      observations.push("deleted the copied auth.json")
    }
    authFileRemoved = !existsSync(layout.authFile)
  } catch (error) {
    authFileRemoved = false
    observations.push(`could not delete the copied auth.json: ${explain(error)}`)
  }

  let scratchRemoved = false
  let scratchKept = false
  if (options.keep) {
    scratchKept = true
    observations.push(`scratch kept at ${layout.root}`)
  } else {
    try {
      rmSync(layout.root, { recursive: true, force: true })
    } catch (error) {
      observations.push(`could not remove scratch: ${explain(error)}`)
    }
    scratchRemoved = !existsSync(layout.root)
    if (!scratchRemoved) observations.push(`scratch still exists at ${layout.root}`)
  }
  observations.push(`${serviceJson} was read only`)
  return { processStopped, portClosed, scratchRemoved, scratchKept, authFileRemoved, observed: observations.join("; ") }
}
