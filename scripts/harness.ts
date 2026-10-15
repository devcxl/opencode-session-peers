/**
 * `bun run harness`.
 *
 * Thin on purpose: parse, run, print, exit non-zero when an expectation was not
 * met. The runnable pieces live in `scripts/harness/`.
 */

import { USAGE, UsageError, parseArgs, wantsHelp } from "./harness/args.ts"
import { renderReport } from "./harness/report.ts"
import { runHarness } from "./harness/run.ts"

const argv = process.argv.slice(2)

if (wantsHelp(argv)) {
  process.stdout.write(USAGE)
} else {
  try {
    const options = parseArgs(argv)
    const report = await runHarness(options)
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report))
    if (!report.ok) process.exitCode = 1
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`harness: ${error.message}\n\n${USAGE}`)
      process.exitCode = 2
    } else {
      throw error
    }
  }
}
