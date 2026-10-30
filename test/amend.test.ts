import { describe, expect, test } from "vitest"
import { checkEdit, withEdits } from "../src/board/amend"
import type { TermSheet } from "../src/schema/termsheet"
import { Dataset, hasDataset } from "../src/tools/dataset"

// A reviewer's edits on the board are checked by code, with the Critic's own term checks; no model.
describe.skipIf(!hasDataset())("board: editing a term before approval", () => {
  const data = Dataset.load()
  const pairId = "C001-CH1__R1015" // R1015 is open to joint projects and industrial PhDs
  const agreed: TermSheet = {
    engagement: "joint_project",
    scope: "Anomaly detection for Modbus and BACnet traffic",
    ip: "uni_owns_option_to_licence",
    exclusivity: { field: "OT anomaly detection", months: 12 },
    publication: { reviewDays: 60, companyMayRemoveConfidential: true },
    backgroundIp: [],
    contributions: { company: [], university: [] },
    money: "to be agreed",
    timeline: { months: 18, milestones: [] },
    contact: { company: "Head of R&D", university: "Principal investigator" },
  }

  test("an allowed edit passes and records what was agreed", () => {
    expect(checkEdit(data, pairId, agreed, {}, "reviewDays", "30")).toEqual({ ok: true, edit: { from: 60, to: 30 } })
    expect(checkEdit(data, pairId, agreed, {}, "engagement", "industrial_phd")).toEqual({ ok: true, edit: { from: "joint_project", to: "industrial_phd" } })
    expect(withEdits(agreed, { reviewDays: { from: 60, to: 30 } }).publication.reviewDays).toBe(30)
  })

  test("the Critic's term checks refuse what the agents could not agree either", () => {
    const refused = (term: string, value: string) => checkEdit(data, pairId, agreed, {}, term, value)
    expect(refused("engagement", "contract_research")).toMatchObject({ ok: false, reason: expect.stringContaining("policy") })
    expect(refused("money", "€40,000 from the company")).toMatchObject({ ok: false, reason: expect.stringContaining("policy") })
    expect(refused("reviewDays", "45")).toMatchObject({ ok: false })
    expect(refused("exclusivityMonths", "36")).toMatchObject({ ok: false })
    expect(refused("scope", "anything")).toMatchObject({ ok: false })
  })
})
