import { expect, test } from "bun:test"

import { removeIfStill, type RecordStore } from "../src/host/storage.ts"

test("a refresh between the stale check and removal can still be deleted", async () => {
  let current: { updatedAt: number } | undefined = { updatedAt: 1 }
  const store: RecordStore<{ updatedAt: number }> = {
    async read() { return current },
    async write(_id, value) { current = value },
    async remove() {
      current = { updatedAt: 100 } // A concurrent heartbeat lands after the read.
      current = undefined
    },
    async list() { return [] },
  }
  expect(await removeIfStill(store, "peer", (value) => value.updatedAt < 50)).toBe(true)
  expect(current).toBeUndefined()
})
