/**
 * The clock and interval seam for observation.
 *
 * Production uses the host process clock and unref'd timers. Tests inject a
 * deterministic scheduler so a two-minute window can be advanced without
 * waiting, and so a clock jump can be exercised directly.
 */

export interface SchedulerRegistration {
  dispose(): void
}

export interface Scheduler {
  now(): number
  every(intervalMs: number, callback: () => void | Promise<void>): SchedulerRegistration
}

export function systemScheduler(): Scheduler {
  return {
    now: () => Date.now(),
    every(intervalMs, callback) {
      const timer = setInterval(() => {
        void Promise.resolve(callback()).catch(() => {
          // The observer owns its warning path; a failed tick must not crash
          // the host's timer.
        })
      }, intervalMs)
      timer.unref?.()
      return { dispose: () => clearInterval(timer) }
    },
  }
}
