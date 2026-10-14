/**
 * The driving phase against a fake instance API: a refused turn is asked for
 * again in a fresh session, the report names the session that answered, and a
 * turn that is refused every time fails the run with every attempt in the
 * report. No real instance, no model, no network.
 */

import { describe, expect, test } from "bun:test"
import { parseArgs } from "../scripts/harness/args.ts"
import { createClient, type SessionInfo, type SessionMessage } from "../scripts/harness/client.ts"
import type { Expectation, SessionSummary } from "../scripts/harness/report.ts"
import { driveTurns, summarizeSession } from "../scripts/harness/sessions.ts"

interface FakeSession {
  id: string
  directory: string
  title: string
  outcome?: string
  messages: SessionMessage[]
}

const REFUSAL = { type: "provider.auth", message: "the host refused this turn" }
const BEGIN = { created: 0, updated: 0 }

function sessionInfo(session: FakeSession): SessionInfo {
  return {
    id: session.id,
    title: session.title,
    time: BEGIN,
    location: { directory: session.directory },
    ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
  }
}

/** The smallest instance API the driving phase uses. */
function fakeInstance(initial: readonly FakeSession[], refuse: (sessionID: string) => boolean) {
  const sessions = new Map(initial.map((session) => [session.id, session]))
  let created = 0

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
    const json = (body: unknown) => new Response(JSON.stringify({ data: body }), { status: 200 })
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>)

    if (init?.method === "POST" && url.pathname === "/api/session") {
      created += 1
      const location = body!["location"] as { directory: string }
      const session: FakeSession = {
        id: `ses_created_${created}`,
        directory: location.directory,
        title: String(body!["title"]),
        messages: [],
      }
      sessions.set(session.id, session)
      return json(sessionInfo(session))
    }

    const match = /^\/api\/session\/([^/]+)(\/prompt|\/context)?$/.exec(url.pathname)
    if (match === null) throw new Error(`the fake instance does not serve ${url.pathname}`)
    const session = sessions.get(match[1]!)
    if (session === undefined) throw new Error(`no such session ${match[1]}`)

    if (url.pathname.endsWith("/prompt")) {
      session.messages.push({ id: "msg_user", type: "user", text: (body!["text"] as string) ?? "" })
      if (refuse(session.id)) {
        session.outcome = "failed"
        session.messages.push({ id: "msg_refused", type: "assistant", error: REFUSAL })
      } else {
        session.outcome = "succeeded"
        session.messages.push({ id: "msg_answer", type: "assistant", text: "HARNESS_SESSION_A_OK" })
      }
      return json(sessionInfo(session))
    }
    if (url.pathname.endsWith("/context")) return json(session.messages)
    return json(sessionInfo(session))
  }

  return { client: createClient("http://instance.invalid", "fake-password", fetchImpl as typeof fetch), count: () => created }
}

async function drive(refuse: (sessionID: string) => boolean) {
  const underTest: FakeSession = {
    id: "ses_under_test",
    directory: "/scratch/project-a",
    title: "harness-a",
    messages: [],
  }
  const { client, count } = fakeInstance([underTest], refuse)
  const sessions: SessionSummary[] = [summarizeSession("A", sessionInfo(underTest))]
  const expectations: Expectation[] = []
  const disclosures: string[] = []
  const driven = await driveTurns(client, parseArgs(["--no-model"]), sessions, expectations, disclosures).then(
    (value) => value,
    (error: Error) => error,
  )
  return { driven, expectations, disclosures, created: count() }
}

describe("driving a session", () => {
  test("a refused turn is asked for again in a fresh session", async () => {
    const { driven, expectations, disclosures, created } = await drive((sessionID) => sessionID === "ses_under_test")

    expect(driven).not.toBeInstanceOf(Error)
    const sessions = driven as SessionSummary[]
    expect(created).toBe(1)
    expect(sessions[0]!.directory).toBe("/scratch/project-a")
    expect(sessions[0]!.id).toBe("ses_created_1")

    const turns = expectations.find((expectation) => expectation.name === "turns-complete")!
    expect(turns.met).toBe(true)
    expect(turns.observed).toContain("A: succeeded")
    expect(turns.observed).toContain("attempt 2 of 3")
    expect(turns.observed).toContain("earlier: failed — the host refused this turn")
    expect(disclosures.join(" ")).toContain("session A was created more than once after a failed turn")
    expect(disclosures.join(" ")).toContain("ses_created_1")
  })

  test("a turn that is refused every time fails the run and names every attempt", async () => {
    const { driven, expectations, disclosures, created } = await drive(() => true)

    expect(driven).toBeInstanceOf(Error)
    expect(created).toBe(2)
    const turns = expectations.find((expectation) => expectation.name === "turns-complete")!
    expect(turns.met).toBe(false)
    expect(turns.observed).toContain("A: failed")
    expect(turns.observed).toContain("attempt 3 of 3")
    expect(turns.observed).toContain("the host refused this turn")
    expect(disclosures.join(" ")).toContain("ses_created_1, ses_created_2")
  })
})
