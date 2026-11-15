/**
 * Issue #57 pure-SQLite experiment runner.
 *
 * Run: bun scripts/research/watchdog-ledger/run.ts [--scenario all|registration|quota|...]
 *
 * Every scenario uses real Bun child processes and a plugin-owned scratch
 * database. No model, host database, credential or user service is used.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, type Scenario } from "./experiment.ts"
import {
  busyTimeout,
  corruption,
  durability,
  handover,
  lateSend,
  lww,
  noRefund,
  pending,
  quota,
  registration,
  reserveBeforeSend,
  seal,
  singleHostIdentity,
} from "./scenarios.ts"

const ALL: Array<[string, () => Promise<Scenario>]> = [
  ["registration", registration],
  ["quota", quota],
  ["no-refund", noRefund],
  ["pending-and-unknown", pending],
  ["handover", handover],
  ["late-send", lateSend],
  ["seal", seal],
  ["busy-timeout", busyTimeout],
  ["durability", durability],
  ["identity-and-corruption", corruption],
  ["lww-negative-control", lww],
  ["single-host-identity", singleHostIdentity],
  ["reserve-before-send", reserveBeforeSend],
]

function selected(): Array<[string, () => Promise<Scenario>]> {
  const index = Bun.argv.indexOf("--scenario")
  const inline = Bun.argv.find((argument) => argument.startsWith("--scenario="))
  const name = inline !== undefined ? inline.slice("--scenario=".length) : index === -1 ? "all" : Bun.argv[index + 1]
  if (name === undefined || name === "all") return ALL
  const match = ALL.find(([candidate]) => candidate === name)
  if (match === undefined) {
    console.error(`unknown scenario ${name}; choose one of: ${ALL.map(([candidate]) => candidate).join(", ")}`)
    process.exit(2)
  }
  return [match]
}

mkdirSync(ROOT, { recursive: true })
const startedAt = new Date().toISOString()
const scenarios: Scenario[] = []

for (const [name, run] of selected()) {
  process.stderr.write(`\n[watchdog-ledger] ${name} ... `)
  const scenario = await run()
  scenarios.push(scenario)
  const failed = scenario.checks.filter((item) => !item.ok).length
  process.stderr.write(failed === 0 ? `ok (${scenario.checks.length} checks)\n` : `FAIL (${failed}/${scenario.checks.length})\n`)
}

const summary = {
  kind: "watchdog-ledger-pure-experiments",
  issue: 57,
  startedAt,
  finishedAt: new Date().toISOString(),
  root: ROOT,
  ok: scenarios.every((scenario) => scenario.checks.every((item) => item.ok)),
  scenarios,
}
writeFileSync(join(ROOT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)

for (const scenario of scenarios) {
  console.log(`\n## ${scenario.name}`)
  for (const item of scenario.checks) {
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.ok ? "" : `  ${JSON.stringify(item.detail)}`}`)
  }
}
console.log(`\nsummary: ${join(ROOT, "summary.json")}`)
if (!summary.ok) process.exitCode = 1
