/**
 * The host layer's front door.
 *
 * Everything above this directory — the entry point, the tool, the actions —
 * works against `Host`, so the plugin context is read here and nowhere else.
 * `test/boundaries.test.ts` enforces that; `test/fake-host.ts` implements the
 * same port so the entry path can be driven without an opencode process.
 */

import type { Plugin } from "@opencode/plugin"

import { commandRegistrar, type CommandRegistrar } from "./commands.ts"
import { contextInjector, type ContextInjector } from "./context.ts"
import type { EventSource } from "./events.ts"
import { sessionGeneration, type Generation } from "./generation.ts"
import { permissionLookup, type PermissionLookup } from "./permission.ts"
import { hostRuntime, type HostRuntime } from "./runtime.ts"
import { rpcRegistrar, type RpcRegistrar } from "./rpc.ts"
import { systemScheduler, type Scheduler } from "./scheduler.ts"
import { sessionLookup, type SessionLookup } from "./session.ts"
import { skillRegistrar, type SkillRegistrar } from "./skills.ts"
import { pluginStorage, type PluginStorage } from "./storage.ts"
import { toolRegistrar, type ToolRegistrar } from "./tools.ts"
import { versionControl, type VersionControl } from "./vcs.ts"

/** The location this plugin instance was loaded for: one directory, one project. */
export interface InstanceLocation {
  readonly directory: string
  readonly projectID?: string
}

/** What the plugin may ask of the host it runs inside. */
export interface Host {
  /** Raw plugin options, as configured. `parseConfig` validates them. */
  readonly options: unknown
  /** The real service identity published by this host context. */
  readonly runtime: HostRuntime
  readonly location: InstanceLocation
  readonly sessions: SessionLookup
  /** Same-location permission snapshots; a failure is unknown, not empty. */
  readonly permissions: PermissionLookup
  /** Clock and interval seam for the observer. */
  readonly scheduler: Scheduler
  /** The sending session's own model, asked to write a handover. */
  readonly generation: Generation
  /** What the host knows about a directory's version control, and what it does not. */
  readonly versionControl: VersionControl
  /** The one namespace every instance on the machine can meet in. */
  readonly storage: PluginStorage
  readonly events: EventSource
  /** Appends watchdog text to a session's next normal model context; never prompts. */
  readonly sessionContext: ContextInjector
  readonly tools: ToolRegistrar
  readonly commands: CommandRegistrar
  /** The model-facing text this plugin contributes; a skill the model may load. */
  readonly skills: SkillRegistrar
  /** The plugin's own callable surface, for other plugins to read. */
  readonly rpc: RpcRegistrar
}

export function createHost(context: Plugin.Context): Host {
  return {
    options: context.options,
    runtime: hostRuntime(context),
    location: {
      directory: context.location.directory,
      projectID: context.location.project?.id,
    },
    sessions: sessionLookup(context.session),
    permissions: permissionLookup(context.permission),
    // The fake host installs a deterministic scheduler on its context; a real
    // host has no such field and gets the process clock.
    scheduler:
      (context as unknown as { scheduler?: Scheduler }).scheduler ?? systemScheduler(),
    generation: sessionGeneration(context.session),
    versionControl: versionControl(context.vcs),
    storage: pluginStorage(context.storage),
    events: {
      subscribe: (options) => context.event.subscribe({ signal: options.signal }),
    },
    sessionContext: contextInjector(context.session),
    tools: toolRegistrar(context.tool),
    commands: commandRegistrar(context.command),
    skills: skillRegistrar(context.skill),
    rpc: rpcRegistrar(context.rpc),
  }
}
