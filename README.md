# opencode-session-peers

An [OpenCode](https://opencode.ai) v2 plugin that lets sessions running on the same machine talk to
each other: list peers, send a message, ask a question and block for the answer, hand over context.

**Status: design phase.** No implementation yet. The design is settled and recorded:

- [`CONTEXT.md`](./CONTEXT.md) — the vocabulary this project uses
- [`docs/adr/`](./docs/adr) — the decisions, including the alternatives that were rejected and why
- [`docs/development-plan.md`](./docs/development-plan.md) — module boundaries, milestones, verification
- [`docs/research/`](./docs/research) — the version-pinned facts the design rests on, one file per
  investigation

The behaviour being ported is [`nicobailon/pi-intercom`](https://github.com/nicobailon/pi-intercom)
v0.17.0 (MIT), re-expressed on OpenCode's plugin API rather than on a broker daemon. This project is
not affiliated with it.

## License

MIT
