# Expose one `peers` tool with an action enum

Status: accepted

Context: `pi-intercom` exposes a single `intercom` tool with an `action` enum and eleven parameters,
backed by a 477-line skill document; its own README drifted from the code on one of those parameters,
which is the failure mode of parameter-soup tools. opencode v2 registers tools globally for a loaded
location, takes a plain JSON Schema, and exposes a tool directly to the model with
`options: { codemode: false }`; a plugin cannot register a tool conditionally for one session.

Decision: one `peers` tool with an action enum (`list`, `list-cwd`, `send`, `ask`, `reply`, `pending`,
`status`, `cancel`, `handover`), exposed with `codemode: false`, and `@opencode/plugin` pinned to 2.0.16
— the version resolvable on the development host — rather than to the latest npm release.

Considered options: splitting the surface into a read tool and a write tool, or one tool per action.
Rejected for v1 in favour of keeping `pi-intercom`'s tested prompt and skill text as the mitigation.
Recorded because changing the surface later breaks the model-facing contract.
