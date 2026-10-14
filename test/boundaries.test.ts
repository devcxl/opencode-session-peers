/**
 * Module boundaries, enforced rather than documented.
 *
 * The rule from docs/development-plan.md: `domain/` is host-independent, and
 * `host/` is the only place that talks to opencode. A rule that only lives in a
 * document rots, so this test reads the sources and checks the imports.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const SOURCE_ROOT = join(import.meta.dir, "..", "src")

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(directory, entry.name))
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(/from\s+"([^"]+)"/g)) specifiers.push(match[1]!)
  return specifiers
}

const DOMAIN_FILES = sourceFiles(join(SOURCE_ROOT, "domain"))

describe("domain boundary", () => {
  test("there is something to check", () => {
    expect(DOMAIN_FILES.length).toBeGreaterThan(0)
  })

  test("domain modules import only relative paths that stay inside domain", () => {
    for (const file of DOMAIN_FILES) {
      const source = readFileSync(file, "utf8")
      for (const specifier of importSpecifiers(source)) {
        expect(specifier, `${file} imports ${specifier}`).toStartWith(".")
        expect(specifier, `${file} imports ${specifier}`).not.toContain("..")
      }
    }
  })

  test("domain modules never mention the plugin context", () => {
    for (const file of DOMAIN_FILES) {
      expect(readFileSync(file, "utf8"), `${file} touches ctx`).not.toContain("ctx.")
    }
  })

  test("domain modules do not reach into the layers above them", () => {
    for (const file of DOMAIN_FILES) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        expect(specifier).not.toMatch(/\/(host|peers|ask|actions|handover)\//)
      }
    }
  })

  test("config depends on the domain, not on the layers above it", () => {
    for (const specifier of importSpecifiers(readFileSync(join(SOURCE_ROOT, "config.ts"), "utf8"))) {
      expect(specifier).toStartWith("./domain/")
    }
  })
})
