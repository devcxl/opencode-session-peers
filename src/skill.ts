/**
 * The model-facing text for the supervisor channel (ADR-0002), registered as a
 * skill.
 *
 * The gap it closes is the parent's, not the child's: a child that asks a parked
 * parent is told what happened by the refusal, but a parent can only avoid the
 * situation by choosing `background: true` when it spawns the child — a decision
 * made before any of this plugin's code runs. The description is what the model
 * reads in its skills list; the content is what it reads if it loads the skill.
 */

import { fileURLToPath } from "node:url"

import type { SkillSpec } from "./host/skills.ts"

const SUPERVISOR_SKILL_ID = "session-peers-supervisor"

export const SUPERVISOR_SKILL: SkillSpec = {
  id: SUPERVISOR_SKILL_ID,
  name: SUPERVISOR_SKILL_ID,
  description:
    `How a subagent session reaches the session that spawned it with the peers tool, ` +
    `and why a parent that wants to be asked must spawn the child with background: true.`,
  // Where this text lives; the host shows the directory to the model.
  path: fileURLToPath(import.meta.url),
  content: [
    "# session-peers supervisor channel",
    "",
    "The `peers` tool reaches the session that spawned this one, like it reaches any peer in scope.",
    "",
    '- `peers({ action: "send", ... })` hands the parent a progress report and does not wait.',
    '  A parent inside a subagent call reads it when that call returns.',
    '- `peers({ action: "ask", ... })` waits inside the call for the parent\'s decision.',
    "",
    "A parent inside a `subagent` call that has not returned cannot answer until it does: its",
    "inbox is not drained while it sits in the tool call. An ask from a foreground child is",
    "refused at once instead of waiting out the ask timeout. To stay answerable while a child",
    "runs, spawn it with `background: true`.",
  ].join("\n"),
}
