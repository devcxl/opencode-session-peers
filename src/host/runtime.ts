/**
 * The host runtime facts the correction gate may use.
 *
 * These are public context fields, not guessed private state. They identify
 * the running service and process; they do not prove that no other service is
 * running, which remains an explicit deployment statement.
 */

import type { Plugin } from "@opencode/plugin"

export interface HostRuntime {
  readonly appName: string
  readonly appVersion: string
  readonly platform: string
  readonly arch: string
}

export function hostRuntime(context: Pick<Plugin.Context, "app">): HostRuntime {
  return {
    appName: context.app.name,
    appVersion: context.app.version,
    platform: process.platform,
    arch: process.arch,
  }
}
