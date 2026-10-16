/**
 * The host's RPC surface, as a fake.
 *
 * One subject: what opencode does around a plugin's own callable surface — a
 * definition is registered at the location the plugin was loaded for, calls are
 * dispatched to it and validated against its schemas on both sides, events are
 * pushed to whoever subscribed, and disposal stops all of it. The real host
 * would also route a call by location; the fake keeps every registration and
 * lets a test call one directly, because the location is the host's business
 * and not the plugin's.
 *
 * The schema check is the subset of JSON Schema this project's definitions use;
 * a value it refuses is a value the real host would refuse to deliver.
 */

export interface FakeRpcEvent {
  readonly name: string
  readonly data: Readonly<Record<string, unknown>>
}

/** One RPC surface the plugin registered. */
export interface FakeRpc {
  /** The id the plugin registered under, as clients address it. */
  readonly id: string
  readonly methods: readonly string[]
  /** Events pushed, in order; one subscription sees all of them. */
  readonly events: readonly FakeRpcEvent[]
  /** True once the plugin disposed the registration, as it does when unloaded. */
  readonly disposed: boolean
  /**
   * Invokes one method the way the host does, and checks the answer against the
   * method's own output schema before handing it back — a client would never
   * see a value the schema rejects.
   */
  call(method: string, input?: unknown): Promise<unknown>
}

/** A portable definition, as much of it as the fake needs. */
export interface FakeRpcDefinition {
  readonly id: string
  readonly methods: Readonly<Record<string, { readonly input: unknown; readonly output: unknown }>>
  readonly events: Readonly<Record<string, { readonly schema: unknown }>>
}

export type FakeRpcHandlers = Readonly<
  Record<string, ((input: unknown) => Promise<unknown>) | undefined>
>

interface FakeRpcRecord {
  readonly definition: FakeRpcDefinition
  readonly handlers: FakeRpcHandlers
  readonly events: FakeRpcEvent[]
  disposed: boolean
}

/** What a registration hands back: push an event, or stop answering. */
interface FakeRpcRegistration {
  readonly events: {
    emit(name: string, data: Readonly<Record<string, unknown>>): Promise<void>
  }
  dispose(): Promise<void>
}

export interface FakeRpcSurface {
  /** The context member a plugin registers through, as the host would present it. */
  readonly context: {
    register(definition: FakeRpcDefinition, handlers: FakeRpcHandlers): Promise<FakeRpcRegistration>
  }
  /** Every surface registered so far, built on read: a plugin registers during `setup`. */
  rpcs(): readonly FakeRpc[]
}

export function fakeRpcSurface(): FakeRpcSurface {
  const registrations: FakeRpcRecord[] = []

  return {
    context: {
      async register(definition, handlers) {
        const record: FakeRpcRecord = { definition, handlers, events: [], disposed: false }
        registrations.push(record)
        return {
          events: {
            async emit(name, data) {
              const schema = definition.events[name]?.schema
              // A name the definition does not declare is a bug in the plugin,
              // and the real host refuses it rather than dropping it.
              if (schema === undefined) {
                throw new Error(`No RPC event named "${name}" on ${definition.id}`)
              }
              checkSchema(data, schema, `${definition.id}.${name}`)
              record.events.push({ name, data })
            },
          },
          async dispose() {
            record.disposed = true
          },
        }
      },
    },
    rpcs: () =>
      registrations.map((record) => ({
        get id() {
          return record.definition.id
        },
        get methods() {
          return Object.keys(record.definition.methods)
        },
        get events() {
          return record.events
        },
        get disposed() {
          return record.disposed
        },
        async call(method, input) {
          const definition = record.definition.methods[method]
          if (definition === undefined) {
            throw new Error(`No RPC method named "${method}" on ${record.definition.id}`)
          }
          // The host validates both sides against the portable schemas; a value
          // a client would never receive must not pass for one here either.
          checkSchema(input ?? {}, definition.input, `${record.definition.id}.${method} input`)
          const output = await record.handlers[method]?.(input)
          checkSchema(output, definition.output, `${record.definition.id}.${method} output`)
          return output
        },
      })),
  }
}

/** The one JSON Schema node shape the plugin's own definitions use. */
interface SchemaNode {
  readonly type?: string | readonly string[]
  readonly properties?: Readonly<Record<string, SchemaNode>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
  readonly items?: SchemaNode
}

/**
 * The subset of JSON Schema the host validates portable definitions with, as
 * far as this project's definitions exercise it: types (including a union with
 * `null`), `properties`, `required`, `additionalProperties: false` and `items`.
 * A value that fails here is a value the real host would refuse to deliver, so
 * the fake refuses it too.
 */
function checkSchema(value: unknown, schema: unknown, path: string): void {
  const node = schema as SchemaNode | undefined
  if (node === undefined || node === null || typeof node !== "object") return

  const types =
    node.type === undefined ? undefined : Array.isArray(node.type) ? node.type : [node.type]
  if (types !== undefined && !types.some((type) => matchesType(value, type))) {
    throw new Error(`${path} is ${typeof value}, which ${types.join(" | ")} does not allow`)
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) checkSchema(entry, node.items, `${path}[${index}]`)
    return
  }
  if (typeof value !== "object" || value === null) return

  const properties = node.properties ?? {}
  for (const name of node.required ?? []) {
    if (!(name in value)) throw new Error(`${path}.${name} is required by the schema`)
  }
  for (const [name, entry] of Object.entries(value)) {
    if (entry === undefined) {
      // JSON transport drops an undefined property, so a client would receive
      // something other than what the handler returned.
      throw new Error(`${path}.${name} is undefined, which cannot survive the transport`)
    }
    const property = properties[name]
    if (property === undefined) {
      if (node.additionalProperties === false) {
        throw new Error(`${path}.${name} is not allowed by the schema`)
      }
      continue
    }
    checkSchema(entry, property, `${path}.${name}`)
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null
    case "array":
      return Array.isArray(value)
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value)
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    default:
      return typeof value === type
  }
}
