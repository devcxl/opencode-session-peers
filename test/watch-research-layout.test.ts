import { expect, test } from "bun:test"

import { scratchLayout } from "../scripts/harness/paths.ts"
import { candidateLayout } from "../scripts/research/watchdog-61/candidate-layout.ts"

test("research channel changes only the expected scratch database filename", () => {
  const original = scratchLayout("/tmp/opencode/research-layout", "probe")
  expect(candidateLayout("/tmp/opencode/research-layout", "probe")).toEqual(original)
  const candidate = candidateLayout("/tmp/opencode/research-layout", "probe", "watchdog-location")
  expect(candidate).toEqual({
    ...original,
    database: `${original.data}/opencode/opencode-watchdog-location.db`,
  })
  expect(candidateLayout("/tmp/opencode/research-layout", "probe", "latest")).toEqual(original)
  expect(candidateLayout("/tmp/opencode/research-layout", "probe", "beta")).toEqual(original)
})

test("research channel cannot escape scratch", () => {
  for (const channel of ["../live", "/absolute", "", "a/b"]) {
    expect(() => candidateLayout("/tmp/opencode/research-layout", "probe", channel)).toThrow(
      "invalid research build channel",
    )
  }
})
