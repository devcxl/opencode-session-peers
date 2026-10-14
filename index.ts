/**
 * Package entry point.
 *
 * opencode resolves a local plugin *directory* to `<dir>/index.ts`, so this
 * file is what the host imports; the plugin itself lives under `src/`.
 */
export { default } from "./src/index.ts"
