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
const HOST_DIR = join(SOURCE_ROOT, "host")

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    // .tsx too: the TUI half renders through it, and a boundary the UI can
    // walk around is not a boundary.
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(/from\s+"([^"]+)"/g)) specifiers.push(match[1]!)
  return specifiers
}

const SOURCE_FILES = sourceFiles(SOURCE_ROOT)
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

describe("host boundary", () => {
  test("the plugin context is read only inside the host layer", () => {
    for (const file of SOURCE_FILES.filter((file) => !file.startsWith(`${HOST_DIR}/`))) {
      // `ctx` or `context` followed by a member access is a host call; only the
      // host layer may make one, and everywhere else the context is a parameter
      // that is passed straight on.
      expect(stripComments(readFileSync(file, "utf8")), `${file} reads the plugin context`).not.toMatch(
        /\b(ctx|context)\./,
      )
    }
  })

  test("outside the host layer, the plugin package is imported as a type", () => {
    for (const file of SOURCE_FILES.filter((file) => !file.startsWith(`${HOST_DIR}/`))) {
      for (const line of stripComments(readFileSync(file, "utf8")).split("\n")) {
        if (!line.includes("@opencode/plugin")) continue
        expect(line, `${file} resolves the plugin package at runtime`).toStartWith("import type")
      }
    }
  })
})

/** Comments may talk about the context; only code counts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
}
