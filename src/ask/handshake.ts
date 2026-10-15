/**
 * The ask handshake: how a blocked question learns its answer.
 *
 * The asker's instance writes an ask record to the shared storage and waits for
 * the reply slot beside it to fill. Nothing about the wait lives in memory: the
 * instance that serves the answering session may be a different one — a
 * different directory, a different server process — and storage is the only
 * namespace they share (ADR-0001), so both sides meet there.
 *
 * The wait is bounded twice over: by the ask's own deadline, and by the tool
 * call's abort signal, so an interrupted turn returns instead of hanging. It is
 * deliberately a poll and not a subscription: the host offers no watch on
 * storage, and a wait of minutes makes the latency of a poll invisible.
 */

import type { AskRecord, ReplyRecord } from "../domain/types.ts"
import type { PluginStorage, RecordStore } from "../host/storage.ts"

/** Every ask record the machine has published, as plain values. */
export async function readAsks(storage: PluginStorage): Promise<readonly AskRecord[]> {
  const records = await storage.asks.list()
  return records.map((record) => record.value)
}

export type ReplyWait =
  | { readonly kind: "replied"; readonly reply: ReplyRecord }
  | { readonly kind: "timeout" }
  | { readonly kind: "interrupted" }

export interface ReplyWaitOptions {
  readonly replies: RecordStore<ReplyRecord>
  readonly askID: string
  readonly expiresAt: number
  /** How often the reply slot is read. */
  readonly pollMs: number
  readonly signal: AbortSignal
}

export async function waitForReply(options: ReplyWaitOptions): Promise<ReplyWait> {
  for (;;) {
    // The read comes first on every pass: an answer that landed before the
    // deadline — or just before an interrupt — is the answer, either way.
    const reply = await options.replies.read(options.askID)
    if (reply !== undefined) return { kind: "replied", reply }

    if (options.signal.aborted) return { kind: "interrupted" }
    const now = Date.now()
    if (now >= options.expiresAt) return { kind: "timeout" }
    await sleep(Math.min(options.pollMs, options.expiresAt - now), options.signal)
  }
}

/**
 * How often to look for the answer: a twentieth of the wait, so a reply is
 * noticed soon at any configured timeout, clamped so a very short wait still
 * polls and a ten-minute one does not hammer the host's storage.
 */
export function replyPollMs(askTimeoutMs: number): number {
  return Math.min(1_000, Math.max(20, Math.floor(askTimeoutMs / 20)))
}

/** Resolves after `ms`, or early when the signal aborts. Never rejects. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    signal.addEventListener("abort", finish, { once: true })
  })
}
