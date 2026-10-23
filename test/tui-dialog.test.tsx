/** @jsxImportSource @opentui/solid */

/**
 * The dialog, driven through the toolkit's headless renderer.
 *
 * `view.ts` is asserted cell by cell in `tui-view.test.ts`; this file asserts
 * the one thing that test cannot see — that the cells reach the screen, in a
 * table, and that a state change swaps the content of the elements the dialog
 * already has rather than rebuilding its shape.
 */

import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"

import type { RosterPayload } from "../src/rpc.ts"
import type { TuiPalette } from "../src/host/tui.ts"
import { RosterDialog } from "../src/tui/dialog.tsx"
import type { RosterState } from "../src/tui/view.ts"

const palette: TuiPalette = {
  base: RGBA.fromHex("#cdd6f4"),
  muted: RGBA.fromHex("#7f849c"),
  error: RGBA.fromHex("#f38ba8"),
}

function payload(overrides: Partial<RosterPayload> = {}): RosterPayload {
  return {
    enabled: true,
    scope: "default",
    rosterTtlMs: 90_000,
    peers: [
      {
        sessionID: "ses_aaaa1111",
        title: "Payments API",
        directory: "/work/alpha",
        status: "busy",
        statusReason: null,
      },
      {
        sessionID: "ses_bbbb2222",
        title: "Docs site",
        directory: "/work/beta",
        status: null,
        statusReason: "not seen running since this instance started",
      },
    ],
    quietInScope: 0,
    liveInOtherScopes: 0,
    ...overrides,
  }
}

async function rendered(initial: RosterState) {
  const [state, setState] = createSignal<RosterState>(initial)
  const setup = await testRender(
    () => (
      <RosterDialog
        state={state}
        viewpoint={{ sessionID: "ses_self0000", directory: "/work/alpha" }}
        palette={() => palette}
      />
    ),
    { width: 100, height: 20 },
  )
  await setup.flush()
  const frame = () => setup.captureCharFrame()
  // A cell wraps at the column edge, so a phrase can cross a line break, with
  // the neighbouring cells' borders in between; the phrase assertions read the
  // frame as prose — borders stripped, breaks collapsed — the way an eye does.
  const text = () => frame().replace(/[│─┌┐└┘├┤┬┴┼]+/g, " ").replace(/\s+/g, " ")
  return { setup, frame, text, setState }
}
describe("the dialog draws the roster as a table", () => {
  test("one row per peer, with the borders of a table", async () => {
    const { frame, text } = await rendered({ kind: "payload", payload: payload() })
    expect(text()).toContain("Session peers")
    expect(text()).toContain("scope: default")
    // The table frame itself.
    expect(frame()).toContain("┌")
    expect(frame()).toContain("┤")
    // The header row.
    expect(text()).toContain("Session")
    expect(text()).toContain("Marks")
    // One row per peer: title, folded id, directory, status, marks.
    expect(text()).toContain("Payments API")
    expect(text()).toContain("…1111")
    expect(text()).toContain("/work/alpha")
    expect(text()).toContain("busy")
    // The marks are read against this viewpoint's directory (/work/alpha).
    expect(text()).toContain("same dir")
  })

  test("an unknown status says unknown and its reason, never idle", async () => {
    const { text } = await rendered({ kind: "payload", payload: payload() })
    expect(text()).toContain("unknown · not seen running since this instance started")
    expect(text()).not.toContain("idle")
  })

  test("an empty roster still explains itself", async () => {
    const { text } = await rendered({ kind: "payload", payload: payload({ peers: [] }) })
    expect(text()).toContain("No peer in this scope loads the plugin.")
  })

  test("a failed call says why, and shows no table", async () => {
    const { frame, text } = await rendered({
      kind: "failed",
      reason: "RPC is unavailable: session-peers.v1",
    })
    expect(text()).toContain("Session peers is unavailable")
    expect(text()).toContain("RPC is unavailable: session-peers.v1")
    expect(frame()).not.toContain("┌")
  })
})

describe("the dialog stays open and live", () => {
  test("a state change swaps the rows without reopening", async () => {
    const { setup, frame, text, setState } = await rendered({ kind: "loading" })
    expect(text()).toContain("reading the roster…")

    setState({
      kind: "payload",
      payload: payload({
        peers: [
          {
            sessionID: "ses_cccc3333",
            title: "Arrived late",
            directory: "/work/gamma",
            status: "idle",
            statusReason: null,
          },
        ],
      }),
    })
    await setup.flush()
    expect(text()).not.toContain("reading the roster…")
    expect(text()).toContain("Arrived late")
    expect(text()).toContain("…3333")
    // The elements were reused, not remade: the frame is still a table.
    expect(frame()).toContain("┌")
  })
})
