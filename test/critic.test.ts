import { describe, expect, test } from "vitest"
import { checkClaim, type CriticContext } from "../src/agents/critic"
import type { Claim } from "../src/schema/claim"
import type { NegotiationMove, TermSheet } from "../src/schema/termsheet"
import { Dataset, hasDataset } from "../src/tools/dataset"
import { normalize } from "../src/tools/normalize"
import { allowedEngagements, availabilityOf } from "../src/tools/profile"

const data = hasDataset() ? Dataset.load() : undefined
const researcher = (id: string) => data!.researchers.get(id)!

test("normalization matches Cyrillic to Latin, dash and quote variants, case and spacing", () => {
  expect(normalize("Универзитет  у Новом Саду")).toBe(normalize("Univerzitet u Novom Sadu"))
  expect(normalize("Modbus — “BACnet”")).toBe(normalize('modbus - "bacnet"'))
})

// Real ids from the pinned dataset; skipped on a clone without data/einstein.
describe.skipIf(!data)("profiles: the stale-profile trap", () => {
  test("availability comes from notes; the stricter source wins over open_to", () => {
    expect(availabilityOf(researcher("R0881")).availability).toBe("unavailable") // open_to: consulting; notes: fully retired
    expect(availabilityOf(researcher("R0068")).availability).toBe("unavailable") // left the university
    expect(availabilityOf(researcher("R0079")).availability).toBe("consulting_only")
    expect(availabilityOf(researcher("R0090")).availability).toBe("consulting_only")
    expect(availabilityOf(researcher("R0097")).availability).toBe("consulting_only")
    expect(availabilityOf(researcher("R1015")).availability).toBe("available")
  })

  test("free-text open_to maps to engagement types", () => {
    expect(allowedEngagements(researcher("R1015"))).toEqual(["joint_project", "industrial_phd"])
    expect(allowedEngagements(researcher("R0416"))).toEqual(["joint_project", "industrial_phd", "contract_research", "consulting", "internship"])
    expect(allowedEngagements(researcher("R0881"))).toEqual([])
    expect(allowedEngagements(researcher("R0090"))).toEqual(["consulting"])
  })
})

describe.skipIf(!data)("critic: deterministic checks", () => {
  const sheet = (engagement: TermSheet["engagement"]): TermSheet => ({
    engagement,
    scope: "Anomaly detection for Modbus and BACnet traffic [C001-CH1]",
    ip: "uni_owns_nonexclusive_licence",
    exclusivity: { field: "", months: 0 },
    publication: { reviewDays: 60, companyMayRemoveConfidential: true },
    backgroundIp: [],
    contributions: { company: [], university: [] },
    money: "to be agreed",
    timeline: { months: 36, milestones: [] },
    contact: { company: "head of engineering", university: "associate professor" },
  })
  const moves: Record<string, NegotiationMove> = {
    "C001-CH1__R0881": { pairId: "C001-CH1__R0881", side: "company", round: 1, action: "propose", sheet: sheet("consulting"), reason: "", citations: [], changes: [] },
    "C001-CH1__R1015": { pairId: "C001-CH1__R1015", side: "company", round: 1, action: "propose", sheet: sheet("industrial_phd"), reason: "", citations: [], changes: [] },
  }
  const ctx: CriticContext = { data: data!, move: (pairId, round) => (round === 1 ? moves[pairId] : undefined) }
  const pubClaim = (subject: string, quote: string, id = "SYN-PUB-01689"): Claim => ({
    id: "cl-1",
    subject,
    kind: "fact",
    text: "Has published on emulsion stability before spray drying.",
    sources: [{ id, field: "title", quote }],
  })
  const title = "Influence of homogenisation pressure on emulsion stability"
  const termClaim = (pairId: string, engagement: string): Claim => ({
    id: "cl-t",
    subject: pairId.split("__")[1],
    kind: "term",
    text: `Format: ${engagement}`,
    sources: [{ id: `move:${pairId}:1`, field: "sheet.engagement", quote: engagement }],
  })

  test("ownership: R0128's paper cited for R0881, the other Nina Mamužić, is blocked; for R0128 it passes", () => {
    expect(checkClaim(pubClaim("R0881", title), ctx)).toMatchObject({ verdict: "block", check: "ownership" })
    expect(checkClaim(pubClaim("R0128", title), ctx)).toMatchObject({ verdict: "pass" })
  })

  test("exists: a fake publication id is blocked", () => {
    expect(checkClaim(pubClaim("R0128", title, "SYN-PUB-99999"), ctx)).toMatchObject({ verdict: "block", check: "exists" })
  })

  test("quote: a real id with an altered quote is blocked", () => {
    expect(checkClaim(pubClaim("R0128", "Influence of extrusion pressure on emulsion stability"), ctx)).toMatchObject({ verdict: "block", check: "quote" })
  })

  test("quote: list fields match when quoted comma-separated, as the writer did on the first live run", () => {
    const keywords = (quote: string): Claim => ({
      id: "cl-k",
      subject: "R1015",
      kind: "fact",
      text: "Works on intrusion and anomaly detection for industrial control systems.",
      sources: [{ id: "R1015", field: "keywords", quote }],
    })
    expect(checkClaim(keywords("intrusion detection, industrial control systems, anomaly detection, IoT security"), ctx)).toMatchObject({ verdict: "pass" })
    expect(checkClaim(keywords("intrusion detection, smart grids"), ctx)).toMatchObject({ verdict: "block", check: "quote" })
  })

  test("policy: any engagement offered to R0881 is blocked; R1015 may get an industrial PhD but not consulting", () => {
    expect(checkClaim(termClaim("C001-CH1__R0881", "consulting"), ctx)).toMatchObject({ verdict: "block", check: "policy" })
    expect(checkClaim(termClaim("C001-CH1__R1015", "industrial_phd"), ctx)).toMatchObject({ verdict: "pass" })
    expect(checkClaim(termClaim("C001-CH1__R1015", "consulting"), ctx)).toMatchObject({ verdict: "block", check: "quote" }) // not what was agreed
  })

  test("policy: praising a person is blocked", () => {
    expect(checkClaim({ ...pubClaim("R0128", title), text: "A leading expert in spray drying." }, ctx)).toMatchObject({ verdict: "block", check: "policy" })
  })

  test("numbers: a euro figure with no source is blocked", () => {
    const claim: Claim = {
      id: "cl-2",
      subject: "C001",
      kind: "fact",
      text: "ArmaturaSec will fund the work with €50,000 and engineers.",
      sources: [{ id: "C001", field: "rd_capacity", quote: "one to two engineers part-time" }],
    }
    expect(checkClaim(claim, ctx)).toMatchObject({ verdict: "block", check: "numbers" })
    expect(checkClaim({ ...claim, text: "ArmaturaSec can dedicate one to two engineers part-time." }, ctx)).toMatchObject({ verdict: "pass" })
  })

  test("policy: a negotiated amount of money is blocked even though it quotes the term sheet", () => {
    moves["C001-CH1__R1015"].sheet.money = "€50,000 from the company"
    const money: Claim = {
      id: "cl-m",
      subject: "C001-CH1__R1015",
      kind: "term",
      text: "Money: €50,000 from the company",
      sources: [{ id: "move:C001-CH1__R1015:1", field: "sheet.money", quote: "€50,000 from the company" }],
    }
    expect(checkClaim(money, ctx)).toMatchObject({ verdict: "block", check: "policy" })
    moves["C001-CH1__R1015"].sheet.money = "to be agreed"
  })
})
