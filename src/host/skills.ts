/**
 * Skill registration.
 *
 * The host lets a plugin contribute a skill: an id, a one-line description the
 * model sees in its skills list, and the text the `skill` tool hands it. That is
 * the surface the supervisor channel's model-facing text lives on (ADR-0002),
 * because the audience is a parent *before* it spawns anything — a place no
 * refusal and no tool result can reach.
 */

import type { Plugin } from "@opencode/plugin"

/** A skill as this plugin declares it: text for the model, nothing host-specific. */
export interface SkillSpec {
  readonly id: string
  readonly name: string
  readonly description: string
  /** Absolute path the text lives at; the host shows its directory to the model. */
  readonly path: string
  readonly content: string
}

export interface SkillRegistrar {
  register(skill: SkillSpec): Promise<void>
}

export function skillRegistrar(skill: Pick<Plugin.Context["skill"], "transform">): SkillRegistrar {
  return {
    async register(spec) {
      await skill.transform((editor) => {
        // The host brands id, name and path; the strings are the whole value.
        editor.add(spec as Parameters<typeof editor.add>[0])
      })
    },
  }
}
