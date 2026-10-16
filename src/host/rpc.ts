/**
 * RPC registration.
 *
 * The host lets a plugin answer its own methods at the location it is loaded
 * for, and push its own events to whoever subscribed
 * (`docs/research/tui-surface-data-path.md` §1). The adapter keeps the host's
 * generics out of the layers above: a caller registers a plain definition and
 * gets back what it may do with the registration — emit, and dispose.
 *
 * `RpcHandlers` is the host's own parameter type rather than a copy of it: two
 * syntactically identical mapped types are not interchangeable while the
 * definition is still a type parameter, and the port has exactly one caller.
 */

import type { Plugin, Rpc } from "@opencode/plugin"

type RawRpc = Pick<Plugin.Context["rpc"], "register">
type RawRegister = RawRpc["register"]

/** One entry per method of the definition; the host validates both sides. */
export type RpcHandlers = Parameters<RawRegister>[1]

export interface RpcRegistration {
  /** Pushes one event to every client subscribed to this definition. */
  emit(name: string, data: Readonly<Record<string, unknown>>): Promise<void>
  /** Stops answering: a call after this fails as `rpc.unavailable`. */
  dispose(): Promise<void>
}

export interface RpcRegistrar {
  register(definition: Rpc.PortableDefinition, handlers: RpcHandlers): Promise<RpcRegistration>
}

export function rpcRegistrar(rpc: RawRpc): RpcRegistrar {
  return {
    async register(definition, handlers) {
      const registration = await rpc.register(definition, handlers)
      return {
        emit: (name, data) => registration.events.emit(name, data),
        dispose: () => registration.dispose(),
      }
    },
  }
}
