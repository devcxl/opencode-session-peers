/**
 * Version control facts for a handover header.
 *
 * The host has a version control surface, and it is used first: `vcs.get` is
 * the host's own answer for a directory, so the branch comes from what the
 * host shows the user rather than from a second opinion. What the host does
 * *not* expose, in the installed `@opencode/plugin` 2.0.16, is the head commit:
 * `Vcs.Info` carries `{ provider?, branch: { current?, default? } }` and
 * nothing else, `vcs.base` returns a base ref for diffs, and there is no hook
 * or event carrying a revision (`docs/research/opencode-v2-plugin-api.md`
 * §9.3, `@opencode/schema/vcs.d.ts`). The head is therefore read with `git
 * rev-parse` — the smallest honest alternative, and the one the original used
 * for both facts (`handover.ts:87-98`).
 *
 * No version control facts is a legitimate outcome, not an error: a session
 * working outside a repository gets a header without that line, as the
 * original's did.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { Plugin } from "@opencode/plugin"

import type { VersionControlFacts } from "../domain/handover.ts"

const run = promisify(execFile)

/** Long enough for a cold `git` on a large repository, short enough not to hold a tool call. */
const GIT_TIMEOUT_MS = 2_000

export interface VersionControl {
  /**
   * The head commit and branch of a working directory, or nothing when neither
   * the host nor `git` can name the directory as a repository.
   */
  facts(directory: string): Promise<VersionControlFacts | undefined>
}

export function versionControl(vcs: Pick<Plugin.Context["vcs"], "get">): VersionControl {
  return {
    async facts(directory) {
      const fromHost = await hostBranch(vcs, directory)
      const fromGit = await gitFacts(directory)
      // The host answers first for the branch; the head commit is git's word
      // either way, because the host has none to give.
      const branch = fromHost ?? fromGit?.branch
      if (branch === undefined && fromGit?.head === undefined) return undefined
      return {
        ...(branch === undefined ? {} : { branch }),
        ...(fromGit?.head === undefined ? {} : { head: fromGit.head }),
      }
    },
  }
}

/** The branch the host would show for this directory; nothing when it has no repository there. */
async function hostBranch(
  vcs: Pick<Plugin.Context["vcs"], "get">,
  directory: string,
): Promise<string | undefined> {
  try {
    const info = await vcs.get({ location: { directory } })
    const current = info.data.branch.current?.trim()
    return current === undefined || current.length === 0 ? undefined : current
  } catch {
    // A directory the host cannot place is a directory with no version control
    // facts to report, which the header handles by leaving them out.
    return undefined
  }
}

async function gitFacts(directory: string): Promise<VersionControlFacts | undefined> {
  try {
    // One call for both facts; `--abbrev-ref HEAD` answers `HEAD` itself on a
    // detached checkout, which the header renders as "detached HEAD".
    const { stdout } = await run("git", ["rev-parse", "HEAD", "--abbrev-ref", "HEAD"], {
      cwd: directory,
      timeout: GIT_TIMEOUT_MS,
    })
    const [head, branch] = stdout.trim().split("\n")
    if (head === undefined || head.length === 0) return undefined
    return {
      ...(branch === undefined || branch.length === 0 ? {} : { branch }),
      head,
    }
  } catch {
    // Not a repository, or no git binary: the handover goes out without it.
    return undefined
  }
}
