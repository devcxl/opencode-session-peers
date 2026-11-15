/**
 * Permission requests, as a same-location snapshot.
 *
 * `permission.list({ sessionID })` is the only snapshot available in the
 * installed plugin types. An empty list is meaningful only when the call
 * succeeds for a session this location serves; a failure or another location
 * is not evidence that nobody is waiting.
 */

import type { Plugin } from "@opencode/plugin"

import type { SessionID } from "../domain/types.ts"

export interface PermissionRequestRecord {
  readonly id: string
  readonly action: string
  readonly resources: readonly string[]
  readonly message?: string
}

export interface PermissionLookup {
  /** Rejects when the host cannot answer; callers must treat that as unknown. */
  list(sessionID: SessionID): Promise<readonly PermissionRequestRecord[]>
}

export function permissionLookup(
  permission: Pick<Plugin.Context["permission"], "list">,
): PermissionLookup {
  return {
    async list(sessionID) {
      const requests = await permission.list({ sessionID })
      return requests.map((request) => ({
        id: request.id,
        action: request.action,
        resources: [...request.resources],
        ...(request.message === undefined ? {} : { message: request.message }),
      }))
    },
  }
}
