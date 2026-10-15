/**
 * The isolation evidence.
 *
 * The one promise this harness makes above all others: the developer's live
 * opencode service is not disturbed. That is checked, not assumed — the live
 * registry file is hashed before and after, and its service pid is read so the
 * report can name what was left alone.
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

export const MISSING = "missing"

/** md5 of a file, or `MISSING` when there is no file to hash. */
export function digestFile(path: string): string {
  try {
    return createHash("md5").update(readFileSync(path)).digest("hex")
  } catch (error) {
    if (isNotFound(error)) return MISSING
    throw error
  }
}

export interface LiveService {
  /** md5 of `service.json` at the moment it was read. */
  digest: string
  pid?: number
  url?: string
}

/**
 * Read the live registry. Anything unparseable is reported as absent rather
 * than guessed: the digest is the assertion, the rest is context.
 */
export function readLiveService(path: string): LiveService {
  const digest = digestFile(path)
  if (digest === MISSING) return { digest }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return { digest }
  }
  if (typeof parsed !== "object" || parsed === null) return { digest }

  const record = parsed as Record<string, unknown>
  const pid = typeof record["pid"] === "number" ? record["pid"] : undefined
  const url = typeof record["url"] === "string" ? record["url"] : undefined
  return { digest, ...(pid === undefined ? {} : { pid }), ...(url === undefined ? {} : { url }) }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isNoSuchProcess(error)) return false
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT"
}

function isNoSuchProcess(error: unknown): boolean {
  return errorCode(error) === "ESRCH"
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined
}
