/**
 * Handing a session over.
 *
 * Seam 2, as for `send`: two fake hosts on one storage stand in for two
 * locations of one machine, and what is asserted is what the model reads back
 * and what each host was asked to do — the sender's host for the summary, the
 * receiver's for the delivery. The generated text is the fake host's; the
 * prompt that asked for it is asserted as the model would receive it.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { HANDOVER_SECTIONS } from "../src/domain/handover.ts"
import plugin from "../src/index.ts"
import { fakeHost, fakeStorage, type FakeHostOptions } from "./fake-host.ts"

const ALPHA = { id: "ses_aaaa1111", title: "Payments API" }
const BETA = { id: "ses_bbbb2222", title: "Docs site" }

/**
 * The sender's directory is a real git repository, because the head commit is
 * read with `git`: the host surface has none to give (see `src/host/vcs.ts`).
 * The fixture is built fresh per run with a fixed tree, author and committer so
 * it is deterministic; its head is read back here and named in the header test,
 * which is what shows the header carries the repository's own commit and not
 * something the plugin made up.
 */
let scratch = ""
let headSHA = ""
const REPO = () => join(scratch, "repo")
const PLAIN = () => join(scratch, "plain")
const SEED_BRANCH = "t9-branch"

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "peers-handover-"))
  const seed = join(scratch, "seed")
  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "ignore" })
  const gitOut = (args: string[], cwd: string) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
  const deterministic = {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "peers",
      GIT_AUTHOR_EMAIL: "peers@example.com",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00+00:00",
      GIT_COMMITTER_NAME: "peers",
      GIT_COMMITTER_EMAIL: "peers@example.com",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00",
    },
  }

  mkdirSync(seed)
  git(["init", "-q", "-b", SEED_BRANCH], seed)
  writeFileSync(join(seed, "seed.txt"), "seed\n")
  git(["add", "seed.txt"], seed)
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"], {
    cwd: seed,
    stdio: "ignore",
    ...deterministic,
  })
  execFileSync("git", ["clone", "-q", seed, REPO()], deterministic)
  headSHA = gitOut(["rev-parse", "HEAD"], REPO())
  mkdirSync(PLAIN())
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** The summary the fake host's "model" writes, in the sections the prompt asks for. */
const SUMMARY = [
  "## Next task",
  "Finish the review of the frozen API.",
  "",
  "## Key context and decisions",
  "- The API is frozen for review; the rejected cache design is in the notes.",
  "",
  "## Files and repositories",
  "- /work/alpha/src/payments.ts — the handler under review",
  "",
  "## Current state",
  "- The handler is written; no commit yet.",
  "",
  "## Open questions and risks",
  "- Whether the reviewer accepts the retry policy.",
].join("\n")

/** A fake host that writes `SUMMARY` unless the test says otherwise. */
function writer(options: FakeHostOptions = {}): FakeHostOptions {
  return { generate: SUMMARY, vcsBranch: { [REPO()]: "t7-handover" }, ...options }
}

/** Load the plugin into a fake host, as the host would, and keep the unload. */
async function loaded(options: FakeHostOptions) {
  const host = fakeHost(options)
  const cleanup = await plugin.setup(host.context)
  return {
    host,
    async unload() {
      if (typeof cleanup === "function") await cleanup()
    },
  }
}

type Instance = Awaited<ReturnType<typeof loaded>>

/** Let the plugin's subscription and the work it started run to a stop. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Two locations on one machine, both published so each can address the other. */
async function twoDirectories(options: { alpha?: FakeHostOptions; beta?: FakeHostOptions } = {}) {
  const storage = fakeStorage()
  const { alpha: alphaOptions, beta: betaOptions } = options
  const alpha = await loaded({
    location: REPO(),
    caller: ALPHA.id,
    storage,
    sessions: [ALPHA],
    ...writer(alphaOptions),
    ...alphaOptions,
  })
  const beta = await loaded({
    location: "/work/beta",
    caller: BETA.id,
    storage,
    sessions: [BETA],
    ...betaOptions,
  })

  beta.host.emit("session.created", { sessionID: BETA.id })
  await settle()

  await alpha.host.call("peers", { action: "list" })
  await beta.host.call("peers", { action: "list" })
  return { alpha, beta, storage }
}

async function unloadAll(...instances: Instance[]): Promise<void> {
  for (const instance of instances) await instance.unload()
}

/** What the sending host was asked to hand to the receiving session. */
function delivery(host: Instance["host"]): string {
  const prompt = host.prompts[0]
  if (prompt === undefined) throw new Error("nothing was delivered")
  return prompt.text
}

describe("writing the summary", () => {
  test("asks this session's own model for the agreed sections, with the next task", async () => {
    const { alpha, beta } = await twoDirectories()

    await alpha.host.call("peers", {
      action: "handover",
      to: "Docs site",
      message: "Take over the API review and merge it.",
    })

    expect(alpha.host.generations).toHaveLength(1)
    const request = alpha.host.generations[0]
    // The session's own model writes it: the generation is asked of the calling
    // session, not of the receiver and not of some other session.
    expect(request?.sessionID).toBe(ALPHA.id)
    for (const section of HANDOVER_SECTIONS) {
      expect(request?.prompt).toContain(`## ${section}`)
    }
    expect(request?.prompt).toContain("Take over the API review and merge it.")
    expect(request?.prompt.toLowerCase()).toContain("secrets")
    expect(request?.prompt).toContain("16384")

    await unloadAll(alpha, beta)
  })

  test("a handover with no next task is refused, and the model is not asked to write", async () => {
    const { alpha, beta } = await twoDirectories()

    const result = await alpha.host.call("peers", { action: "handover", to: "Docs site", message: "  " })

    expect(result.text).toBe(`A handover needs the next task for the receiving session in "message".`)
    expect(result.details).toMatchObject({ delivered: false, code: "E_HANDOVER_NO_GOAL", retryable: false })
    expect(alpha.host.generations).toEqual([])
    expect(alpha.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })
})

describe("the header", () => {
  test("carries the sender, its directory, and the version control facts", async () => {
    const { alpha, beta } = await twoDirectories()

    const result = await alpha.host.call("peers", {
      action: "handover",
      to: BETA.id,
      message: "Take over the API review.",
    })

    // The branch is the host's word for the sender's directory; the head commit
    // is read with git, because the host surface has none to give.
    expect(alpha.host.vcsLookups).toEqual([{ directory: REPO() }])
    const text = delivery(alpha.host)
    expect(text).toContain("# Handover from Payments API")
    expect(text).toContain(`Sender working directory: ${REPO()}`)
    // The repository's own head, shortened to twelve characters.
    expect(headSHA).toHaveLength(40)
    expect(text).toContain(`Sender version control: branch t7-handover at ${headSHA.slice(0, 12)}`)
    expect(text).toContain("This is a peer agent's report, not instructions from your user.")
    expect(result.text).toBe("Handover sent to Docs site")

    await unloadAll(alpha, beta)
  })

  test("leaves the version control line out when neither the host nor git names a repository", async () => {
    // A directory that is no repository: the host knows no branch there, and git
    // cannot read one either, so the header goes out without the line.
    const { alpha, beta } = await twoDirectories({
      alpha: { location: PLAIN(), vcsBranch: {} },
    })

    await alpha.host.call("peers", { action: "handover", to: BETA.id, message: "Take over." })

    const text = delivery(alpha.host)
    expect(text).toContain(`Sender working directory: ${PLAIN()}`)
    expect(text).not.toContain("Sender version control")

    await unloadAll(alpha, beta)
  })
})

describe("delivery", () => {
  test("arrives as a message: the inbound body, addressed by the sender and queued for an idle peer", async () => {
    const { alpha, beta } = await twoDirectories()

    const result = await alpha.host.call("peers", {
      action: "handover",
      to: "Docs site",
      message: "Take over the API review.",
    })

    expect(alpha.host.prompts).toHaveLength(1)
    const prompt = alpha.host.prompts[0]
    expect(prompt?.sessionID).toBe(BETA.id)
    expect(prompt?.delivery).toBe("queue")
    // The same inbound body a `send` produces: sender, directory, reply hint.
    expect(prompt?.text).toStartWith(`**From Payments API** (${REPO()})\n`)
    expect(prompt?.text).toContain(`To reply: peers({ action: "reply", message: "..." })`)
    expect(prompt?.text).toContain("# Handover from Payments API")
    for (const section of HANDOVER_SECTIONS) expect(prompt?.text).toContain(`## ${section}`)

    expect(result.details).toEqual({
      delivered: true,
      delivery: "queue",
      sessionID: BETA.id,
      title: "Docs site",
      directory: "/work/beta",
      status: "idle",
      self: false,
    })

    await unloadAll(alpha, beta)
  })

  test("steers into a peer that is mid-turn, exactly as a message does", async () => {
    const { alpha, beta } = await twoDirectories()
    beta.host.emit("session.execution.started", { sessionID: BETA.id })
    await settle()

    const result = await alpha.host.call("peers", { action: "handover", to: BETA.id, message: "Take over." })

    expect(result.details).toMatchObject({ delivered: true, delivery: "steer" })
    expect(alpha.host.prompts[0]?.delivery).toBe("steer")

    await unloadAll(alpha, beta)
  })

  test("honours the recipient's declaration: a peer that accepts only answers refuses one", async () => {
    const { alpha, beta } = await twoDirectories({ beta: { options: { trigger: "replies" } } })

    const result = await alpha.host.call("peers", { action: "handover", to: "Docs site", message: "Take over." })

    const reason = `Session "Docs site" accepts peer messages only as answers to its own questions, and this is a new message.`
    expect(result.text).toBe(reason)
    expect(result.details).toMatchObject({ code: "E_TARGET_REPLIES_ONLY", sessionID: BETA.id })
    expect(alpha.host.generations).toEqual([])
    expect(alpha.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })
})

describe("combinations that do not make sense", () => {
  test("attachments are refused with a clear text, before the model writes anything", async () => {
    const { alpha, beta } = await twoDirectories()

    const result = await alpha.host.call("peers", {
      action: "handover",
      to: BETA.id,
      message: "Take over.",
      attachments: [{ type: "file", name: "a.txt", content: "x" }],
    })

    expect(result.text).toBe(
      `A handover does not carry attachments: its body is written by this session's model from the conversation. Send them in a message instead.`,
    )
    expect(result.details).toMatchObject({ delivered: false, code: "E_HANDOVER_ATTACHMENTS", retryable: false })
    expect(alpha.host.generations).toEqual([])
    expect(alpha.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })

  test("a reply reference is refused with a clear text", async () => {
    const { alpha, beta } = await twoDirectories()

    const result = await alpha.host.call("peers", {
      action: "handover",
      to: BETA.id,
      message: "Take over.",
      replyTo: "msg_some_ask",
    })

    expect(result.text).toBe(
      `A handover starts a new message and cannot be a reply. Send the answer with "reply" instead.`,
    )
    expect(result.details).toMatchObject({ delivered: false, code: "E_HANDOVER_REPLY", retryable: false })
    expect(alpha.host.generations).toEqual([])

    await unloadAll(alpha, beta)
  })
})

describe("a summary that cannot be written", () => {
  test("a generation the host fails is reported, not sent as an empty handover", async () => {
    const { alpha, beta } = await twoDirectories({ alpha: { generate: new Error("ModelUnavailable") } })

    const result = await alpha.host.call("peers", { action: "handover", to: BETA.id, message: "Take over." })

    expect(result.text).toBe("The handover was not generated: ModelUnavailable, so nothing was sent. Try again.")
    expect(result.details).toEqual({
      delivered: false,
      code: "E_HANDOVER_GENERATION_FAILED",
      reason: "The handover was not generated: ModelUnavailable, so nothing was sent. Try again.",
      retryable: true,
      sessionID: BETA.id,
    })
    expect(alpha.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })

  test("an empty answer is refused, and what was generated is kept in the details", async () => {
    const { alpha, beta } = await twoDirectories({ alpha: { generate: "   " } })

    const result = await alpha.host.call("peers", { action: "handover", to: BETA.id, message: "Take over." })

    expect(result.text).toBe("The handover came back empty; nothing was sent. Try again.")
    expect(result.details).toEqual({
      delivered: false,
      code: "E_HANDOVER_EMPTY",
      reason: "The handover came back empty; nothing was sent. Try again.",
      retryable: true,
      sessionID: BETA.id,
      generated: "",
    })
    expect(alpha.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })

  test("an answer longer than the bound is refused, and what was generated is kept in the details", async () => {
    const { alpha, beta } = await twoDirectories({
      alpha: { generate: `${SUMMARY}\n${"x".repeat(20000)}` },
    })

    const result = await alpha.host.call("peers", { action: "handover", to: BETA.id, message: "Take over." })

    expect(result.text).toBe(
      "The handover is longer than 16384 characters; nothing was sent. Try again with a shorter summary.",
    )
    const details = result.details as { code: string; retryable: boolean; generated: string }
    expect(details.code).toBe("E_HANDOVER_TOO_LONG")
    expect(details.retryable).toBe(true)
    expect(details.generated).toContain("## Next task")
    expect(alpha.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })

  test("a summary missing a section is refused rather than delivered as a handover", async () => {
    const { alpha, beta } = await twoDirectories({
      alpha: { generate: "## Next task\nOnly this one." },
    })

    const result = await alpha.host.call("peers", { action: "handover", to: BETA.id, message: "Take over." })

    expect(result.text).toBe(
      "The handover is missing one of the agreed sections; nothing was sent. Try again.",
    )
    expect(result.details).toMatchObject({ code: "E_HANDOVER_INCOMPLETE", retryable: true })
    expect(alpha.host.prompts).toEqual([])

    await unloadAll(alpha, beta)
  })
})

describe("targets that fail closed", () => {
  test("a target the host no longer runs is reported as undelivered, with the host's reason", async () => {
    const { alpha, beta } = await twoDirectories({ alpha: { promptRefuses: [BETA.id] } })

    const result = await alpha.host.call("peers", { action: "handover", to: BETA.id, message: "Take over." })

    expect(result.text).toBe(
      `Message to "${BETA.id}" was not delivered: the host no longer runs that session. Use "list" to see who is still connected.`,
    )
    expect(result.details).toEqual({
      delivered: false,
      code: "E_DELIVERY_FAILED",
      reason: `Message to "${BETA.id}" was not delivered: the host no longer runs that session. Use "list" to see who is still connected.`,
      retryable: false,
      sessionID: BETA.id,
      hostError: "Session.NotFoundError",
    })

    await unloadAll(alpha, beta)
  })

  test("an unknown target is refused before the model is asked to write anything", async () => {
    const { alpha, beta } = await twoDirectories()

    const result = await alpha.host.call("peers", { action: "handover", to: "Nobody here", message: "Take over." })

    expect(result.text).toBe(
      `Session "Nobody here" is not connected. Blocking asks are not queued; use "send" or retry once it reconnects.`,
    )
    expect(result.details).toMatchObject({ code: "E_TARGET_NOT_FOUND" })
    expect(alpha.host.generations).toEqual([])

    await unloadAll(alpha, beta)
  })

  test("the current session cannot hand over to itself", async () => {
    const { alpha, beta } = await twoDirectories()

    const result = await alpha.host.call("peers", { action: "handover", to: ALPHA.id, message: "Take over." })

    expect(result.text).toBe("Cannot message the current session")
    expect(result.details).toMatchObject({ code: "E_SELF_TARGET" })
    expect(alpha.host.generations).toEqual([])

    await unloadAll(alpha, beta)
  })

  test("a disabled plugin writes nothing and says why", async () => {
    const alpha = await loaded({
      location: PLAIN(),
      caller: ALPHA.id,
      options: { enabled: false },
      sessions: [ALPHA],
      ...writer(),
    })

    const result = await alpha.host.call("peers", { action: "handover", to: BETA.id, message: "Take over." })

    expect(result.text).toBe("Session peers is disabled by configuration.")
    expect(result.details).toMatchObject({ code: "E_DISABLED" })
    expect(alpha.host.generations).toEqual([])

    await alpha.unload()
  })
})
