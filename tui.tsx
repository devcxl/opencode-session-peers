/**
 * TUI entry point for a directory-declared plugin.
 *
 * opencode resolves a plugin *directory* target to `<dir>/tui` (measured with
 * Bun.resolveSync: the loader tries `<dir>/tui.*`, and a package's `exports`
 * are not consulted for a path-like target). A package declared by *name*
 * resolves `<name>/tui` through `package.json`, which is the `./tui` export.
 * Both paths lead to the same entrypoint; this file is the directory path's.
 */
export { default } from "./src/tui/index.tsx"
