import { describe, expect, test } from "vitest"
import { Dataset, hasDataset } from "../src/tools/dataset"
import { trapFlags, type TrapKind } from "../src/tools/profile"

const data = hasDataset() ? Dataset.load() : undefined
const kinds = (id: string): TrapKind[] => trapFlags(data!.researchers.get(id)!, data!).map((f) => f.kind)

// Real ids from the pinned dataset; skipped on a clone without data/einstein.
describe.skipIf(!data)("profiles: trap flags", () => {
  test("notes about someone else: exactly the two documented profiles in the whole dataset", () => {
    const flagged = [...data!.researchers.values()].filter((r) => trapFlags(r, data!).some((f) => f.kind === "identity_conflict")).map((r) => r.id)
    expect(flagged).toEqual(["R0128", "R0191"])
    const flag = trapFlags(data!.researchers.get("R0128")!, data!).find((f) => f.kind === "identity_conflict")!
    expect(flag.source?.quote.startsWith("Vesna Mitrović")).toBe(true)
  })

  test("stale profile: open_to says consulting, notes say fully retired; the stricter source wins and is flagged", () => {
    expect(kinds("R0881")).toEqual(expect.arrayContaining(["unavailable", "open_to_conflict", "same_name"]))
    expect(kinds("R0079")).toContain("consulting_only")
  })

  test("same name, different people: flagged with the other id", () => {
    const flag = trapFlags(data!.researchers.get("R0128")!, data!).find((f) => f.kind === "same_name")!
    expect(flag.detail).toContain("R0881")
    expect(kinds("R0191")).toContain("same_name") // R0435, BioSense
  })

  test("a clean profile has no flags", () => {
    expect(kinds("R1015")).toEqual([])
  })
})
