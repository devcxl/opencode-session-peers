/**
 * The HTTP surface of the throwaway instance.
 *
 * Only the endpoints the harness needs: sessions, their prompts, and their
 * conversations. Authentication is HTTP Basic with the username `opencode` and
 * the password the instance was started with.
 */

const USERNAME = "opencode"

export class ApiError extends Error {
  readonly status: number
  readonly body: string

  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} answered ${status}: ${truncate(body)}`)
    this.name = "ApiError"
    this.status = status
    this.body = body
  }
}

export interface SessionInfo {
  id: string
  title?: string
  outcome?: string
  model?: { providerID: string; id: string } | null
  agent?: string
  time: { created: number; updated: number; idle?: number }
  location: { directory: string }
}

export interface SessionMessage {
  id: string
  type: string
  text?: string
  content?: ReadonlyArray<{ type: string; text?: string }>
  finish?: string
  error?: { type?: string; message?: string }
  model?: { providerID: string; id: string }
}

export interface ModelInfo {
  providerID: string
  id: string
}

export interface HarnessClient {
  listSessions(): Promise<SessionInfo[]>
  createSession(input: CreateSessionInput): Promise<SessionInfo>
  getSession(id: string): Promise<SessionInfo>
  prompt(id: string, text: string): Promise<void>
  context(id: string): Promise<SessionMessage[]>
  models(directory: string): Promise<ModelInfo[]>
}

export interface CreateSessionInput {
  directory: string
  title: string
  model?: { providerID: string; id: string }
}

export function createClient(baseUrl: string, password: string, fetchImpl: typeof fetch = fetch): HarnessClient {
  const authorization = `Basic ${Buffer.from(`${USERNAME}:${password}`).toString("base64")}`

  async function request(method: string, path: string, body?: unknown, directory?: string): Promise<unknown> {
    const headers: Record<string, string> = { authorization, "content-type": "application/json" }
    if (directory !== undefined) headers["x-opencode-directory"] = directory

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (!response.ok) throw new ApiError(method, path, response.status, text)
    return text.length === 0 ? null : JSON.parse(text)
  }

  const data = <T>(envelope: unknown): T => (envelope as { data: T }).data

  return {
    async listSessions() {
      return data<SessionInfo[]>(await request("GET", "/api/session"))
    },
    async createSession(input) {
      const body = {
        location: { directory: input.directory },
        title: input.title,
        ...(input.model === undefined ? {} : { model: input.model }),
      }
      return data<SessionInfo>(await request("POST", "/api/session", body, input.directory))
    },
    async getSession(id) {
      return data<SessionInfo>(await request("GET", `/api/session/${id}`))
    },
    async prompt(id, text) {
      await request("POST", `/api/session/${id}/prompt`, { text, delivery: "queue" })
    },
    async context(id) {
      return data<SessionMessage[]>(await request("GET", `/api/session/${id}/context`))
    },
    async models(directory) {
      return data<ModelInfo[]>(await request("GET", "/api/model", undefined, directory))
    },
  }
}

function truncate(text: string, limit = 300): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`
}
