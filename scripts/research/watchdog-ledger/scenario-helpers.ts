/**
 * Shared assertions and argument builders for the issue #57 scenarios.
 */

import { argsFor, check, workerResult, type Check, type Json, type Scenario, type Scratch, type WorkerRun } from "./experiment.ts"

export function resultOf(run: WorkerRun): Json {
  return (workerResult(run)["result"] as Json | undefined) ?? { missing: true }
}

export function valueOf(run: WorkerRun): Json | undefined {
  return resultOf(run)["value"] as Json | undefined
}

export function codeOf(run: WorkerRun): unknown {
  return resultOf(run)["code"] ?? workerResult(run)["code"]
}

export function payload(run: WorkerRun): Json {
  return workerResult(run)
}

export function reservedOf(run: WorkerRun): Json {
  return (payload(run)["reserved"] as Json | undefined) ?? {}
}

export function reservedValue(run: WorkerRun): Json | undefined {
  return reservedOf(run)["value"] as Json | undefined
}

export function reserveArgs(
  scratch: Scratch,
  reservation: string,
  extra: Record<string, string | number | undefined> = {},
): string[] {
  return argsFor(scratch, "reserve", {
    task: "task-1",
    gen: 1,
    activation: "act-1",
    reservation,
    barrier: scratch.barrier,
    ...extra,
  })
}

export async function scenario(
  name: string,
  fn: (checks: Check[], observations: Json) => Promise<void>,
): Promise<Scenario> {
  const checks: Check[] = []
  const observations: Json = {}
  try {
    await fn(checks, observations)
  } catch (error) {
    check(checks, "scenario completed", false, error instanceof Error ? error.stack : String(error))
  }
  return { name, checks, observations }
}
