import { describe, expect, test } from "vitest"
import { applyFitReview, checkedVerdicts, fitMessage } from "../src/agents/fit-review"
import { checkClaim } from "../src/agents/critic"
import { exclusion } from "../src/agents/matchmaker"
import { oneLine } from "../src/agents/reporter"
import type { ProfileCard } from "../src/schema/profile"
import { Dataset, hasDataset } from "../src/tools/dataset"

// R0820's notes rule out software work: the case the Profiler rated strong for a software prototype (C145-CH1).
describe.skipIf(!hasDataset())("fit review", () => {
  const data = Dataset.load()
  const card = (researcherId: string): ProfileCard => ({ challengeId: "C145-CH1", researcherId, rank: 1, publications: [], availability: "available", allowedEngagements: ["contract_research"], flags: [], expertise: [], blocked: 0, fit: "strong", fitReason: "shared words", cached: true })
  const notes = { id: "R0820", field: "notes", quote: "not in large-scale engineering or software development work" }
  const answer = (verdict: "can_do" | "partly" | "cannot", evidence = [notes], format = "") => ({ coreWork: "Build it.", reviews: [{ researcherId: "R0820", verdict, reason: "Notes rule it out.", evidence, format }] })

  test("the reviewer reads the notes the Profiler doesn't", () => {
    expect(fitMessage(data, "C145-CH1", [card("R0820")])).toContain(notes.quote)
  })

  test("a quoted cannot takes the researcher off the challenge", () => {
    const reviews = checkedVerdicts(answer("cannot"), data, [card("R0820")])
    expect(reviews[0].fit).toBe("none")
    expect(exclusion(applyFitReview(card("R0820"), { coreWork: "Build it.", reviews }))).toMatch(/^no fit: Build it\. Notes rule it out\./)
  })

  test("a cannot without real words counts as partly, so a made-up quote can't remove anyone", () => {
    const reviews = checkedVerdicts(answer("cannot", [{ ...notes, quote: "has never written any code at all" }]), data, [card("R0820")])
    expect(reviews[0].fit).toBe("partial")
  })

  test("a review of someone not on the shortlist is ignored; a card with no review keeps its fit", () => {
    expect(checkedVerdicts(answer("cannot"), data, [card("R0001")])).toEqual([])
    expect(applyFitReview(card("R0820"), { coreWork: "", reviews: [] }).fit).toBe("strong")
  })

  test("a suggested format reaches the card only if the researcher allows it", () => {
    const suggested = (format: string) => applyFitReview(card("R0820"), { coreWork: "Build it.", reviews: checkedVerdicts(answer("can_do", [notes], format), data, [card("R0820")]) }).fitReason
    expect(suggested("contract_research")).toContain("Suggested format: contract_research.")
    expect(suggested("industrial_phd")).not.toContain("Suggested format")
  })
})

describe("no-match report", () => {
  test("a challenge's text that mentions someone's personal situation isn't printed", () => {
    expect(oneLine("One of them is Milica who is going on maternity leave")).not.toContain("Milica")
    expect(oneLine("We need a loan")).toBe("We need a loan")
  })
})

describe("the Critic's praise check", () => {
  const ctx = { data: new Dataset(), move: () => ({ sheet: { contributions: "Full Professor leading research design" } }) as never }
  const claim = (text: string) => ({ id: "x", subject: "C1-CH1__R1", kind: "term" as const, text, sources: [{ id: "move:C1-CH1__R1:4", field: "sheet.contributions", quote: "Full Professor leading research design" }] })

  test("leading work is a role, leading expert is praise", () => {
    expect(checkClaim(claim("Contributions: Full Professor leading research design"), ctx).verdict).toBe("pass")
    expect(checkClaim(claim("Contributions: a leading expert in research design"), ctx)).toMatchObject({ verdict: "block", check: "policy" })
  })
})
