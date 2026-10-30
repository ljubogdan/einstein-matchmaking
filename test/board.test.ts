import { expect, test } from "vitest"
import { Board } from "../src/runtime"

test("a reservation needs the version the caller read; the second matchmaker on the same read loses", () => {
  const board = new Board()
  const seenByA = board.reservation("R1015")?.version ?? 0
  const seenByB = board.reservation("R1015")?.version ?? 0

  expect(board.reserve("R1015", "C001-CH1", seenByA)).toBe(true)
  expect(board.reserve("R1015", "C014-CH2", seenByB)).toBe(false) // stale read: no overwrite
  expect(board.reservation("R1015")).toEqual({ challengeId: "C001-CH1", version: 1 })
})

test("after reading the new version, a reassignment (the Arbiter's decision) goes through", () => {
  const board = new Board()
  board.reserve("R1015", "C001-CH1", 0)
  expect(board.reserve("R1015", "C014-CH2", board.reservation("R1015")!.version)).toBe(true)
  expect(board.reservation("R1015")).toEqual({ challengeId: "C014-CH2", version: 2 })
})

test("researchers are reserved independently", () => {
  const board = new Board()
  expect(board.reserve("R1015", "C001-CH1", 0)).toBe(true)
  expect(board.reserve("R0416", "C001-CH1", 0)).toBe(true)
})

test("of many matchmakers racing on one read, exactly one wins", async () => {
  const board = new Board()
  const read = board.reservation("R1015")?.version ?? 0
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => Promise.resolve().then(() => board.reserve("R1015", `C00${i + 1}-CH1`, read))),
  )
  expect(results.filter(Boolean)).toHaveLength(1)
  expect(board.reservation("R1015")?.version).toBe(1)
})
