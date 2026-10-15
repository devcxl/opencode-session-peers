# opencode-session-peers

## Working rules

- **Write only inside the worktree you were given.** The main checkout at
  `/home/devcxl/Projects/OpenCodePlugins/opencode-session-peers` is loaded by a live session, which
  hot-reloads whatever appears in it — so a stray write there is not a harmless edit, it changes the
  plugin a person is running. A tool that resolves a relative path can land there without saying so:
  check the absolute path before every write, and if it points anywhere outside your worktree, stop and
  correct it rather than continuing.

## Agent skills

### Issue tracker

Issues and specs for this repo live as GitHub issues, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to the default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
