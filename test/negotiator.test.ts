import { expect, test } from "vitest"
import { checkCitations, dropCitations } from "../src/agents/negotiator"
import type { NegotiationReply } from "../src/schema/termsheet"

const card = ["Plans [C001 plans]: a fifth hardware variant in late 2025", "Technology [C001 tech]: Rust; Zeek"].join("\n")
const reply = (reason: string, evidence: NegotiationReply["evidence"]) => ({ reason, evidence, citations: [] }) as unknown as NegotiationReply

test("a citation stays when its quote is on that line of the card", () => {
  const checked = checkCitations(reply("We ship in late 2025 [C001 plans].", [{ citation: "C001 plans", quote: "fifth hardware variant in late 2025" }]), card)
  expect(checked).toMatchObject({ reason: "We ship in late 2025 [C001 plans].", citations: ["C001 plans"], uncited: [] })
})

test("a citation goes when its quote is missing, invented or on another line", () => {
  for (const evidence of [[], [{ citation: "C001 tech", quote: "a data protection policy" }], [{ citation: "C001 tech", quote: "fifth hardware variant" }]]) {
    const checked = checkCitations(reply("A review protects data [C001 tech].", evidence), card)
    expect(checked).toMatchObject({ reason: "A review protects data.", citations: [], evidence: [], uncited: ["C001 tech"] })
  }
})

test("the check's rejected citations leave the reason and the evidence", () => {
  const move = { reason: "We ship in 2025 [C001 plans] and use Rust [C001 tech].", citations: ["C001 plans", "C001 tech"], evidence: [{ citation: "C001 plans", quote: "late 2025" }, { citation: "C001 tech", quote: "Rust" }], uncited: [] }
  expect(dropCitations(move, ["C001 plans"])).toEqual({ reason: "We ship in 2025 and use Rust [C001 tech].", citations: ["C001 tech"], evidence: [{ citation: "C001 tech", quote: "Rust" }], uncited: ["C001 plans"] })
})

test("in a shared bracket, each citation stands or falls alone", () => {
  const checked = checkCitations(reply("Facts [C001 plans, C001 tech].", [{ citation: "C001 tech", quote: "Zeek" }]), card)
  expect(checked).toMatchObject({ reason: "Facts [C001 tech].", uncited: ["C001 plans"] })
})
