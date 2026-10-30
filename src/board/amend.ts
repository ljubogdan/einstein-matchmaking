import { checkClaim } from "../agents/critic"
import { ENGAGEMENT_LABELS, IP_LABELS, termClaims } from "../proposal/terms"
import { ENGAGEMENTS, IP_MODELS, REVIEW_DAYS, type NegotiationMove, type TermSheet } from "../schema/termsheet"
import type { Dataset } from "../tools/dataset"

// The terms a reviewer may change on the board before approving. The rest of the sheet (scope, contributions,
// milestones) is the negotiators' and stays as agreed.
export const EDITABLE = ["engagement", "ip", "reviewDays", "exclusivityMonths", "money"] as const
export type Editable = (typeof EDITABLE)[number]
export type Edit = { from: string | number; to: string | number }

const MAX_EXCLUSIVITY_MONTHS = 24 // the most either negotiator may ask for (negotiator rules)

export function termValue(sheet: TermSheet, term: Editable): string | number {
  if (term === "reviewDays") return sheet.publication.reviewDays
  if (term === "exclusivityMonths") return sheet.exclusivity.months
  return sheet[term]
}

/** The agreed sheet with a reviewer's edits on top. */
export function withEdits(sheet: TermSheet, edits: Partial<Record<Editable, Edit>>): TermSheet {
  const next: TermSheet = structuredClone(sheet)
  for (const [term, edit] of Object.entries(edits) as [Editable, Edit][]) {
    if (term === "reviewDays") next.publication.reviewDays = Number(edit.to)
    else if (term === "exclusivityMonths") next.exclusivity.months = Number(edit.to)
    else if (term === "engagement") next.engagement = edit.to as TermSheet["engagement"]
    else if (term === "ip") next.ip = edit.to as TermSheet["ip"]
    else next.money = String(edit.to)
  }
  return next
}

/**
 * One reviewer edit, checked by code only: the value must be one the term sheet allows, and the edited sheet must pass
 * the Critic's own checks on every agreed term (engagement inside open_to and availability, money never an amount).
 * No model call. Returns the new edit, or the reason it was refused.
 */
export function checkEdit(
  data: Dataset,
  pairId: string,
  agreed: TermSheet,
  edits: Partial<Record<Editable, Edit>>,
  term: string,
  raw: string,
): { ok: true; edit: Edit } | { ok: false; reason: string } {
  if (!(EDITABLE as readonly string[]).includes(term)) return { ok: false, reason: `${term} can't be edited here` }
  const t = term as Editable
  const value = raw.trim()
  if (t === "engagement" && !(ENGAGEMENTS as readonly string[]).includes(value)) return { ok: false, reason: `unknown format ${value}` }
  if (t === "ip" && !(IP_MODELS as readonly string[]).includes(value)) return { ok: false, reason: `unknown IP model ${value}` }
  if (t === "reviewDays" && !REVIEW_DAYS.includes(Number(value))) return { ok: false, reason: `review days must be one of ${REVIEW_DAYS.join(", ")}` }
  if (t === "exclusivityMonths" && !(Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= MAX_EXCLUSIVITY_MONTHS))
    return { ok: false, reason: `exclusivity is 0 to ${MAX_EXCLUSIVITY_MONTHS} months` }
  if (t === "money" && (!value || value.length > 120)) return { ok: false, reason: "money is 'to be agreed' or a short funding route" }

  const to = t === "reviewDays" || t === "exclusivityMonths" ? Number(value) : value
  const from = termValue(agreed, t)
  const sheet = withEdits(agreed, { ...edits, [t]: { from, to } })
  // The Critic reads terms from a recorded move; this one exists only for the check.
  const move = { pairId, side: "company", round: 1, action: "accept", sheet, reason: "", citations: [], evidence: [], changes: [] } as unknown as NegotiationMove
  const researcherId = pairId.split("__")[1]
  for (const claim of termClaims(move, researcherId)) {
    const verdict = checkClaim(claim, { data, move: () => move })
    if (verdict.verdict !== "pass") return { ok: false, reason: `the Critic's ${verdict.check} check: ${verdict.reason}` }
  }
  return { ok: true, edit: { from, to } }
}

/** How an edit reads on the proposal page. */
export function editLine(term: Editable, edit: Edit): string {
  const show = (v: string | number) =>
    term === "engagement" ? ENGAGEMENT_LABELS[v as TermSheet["engagement"]] ?? String(v)
    : term === "ip" ? IP_LABELS[v as TermSheet["ip"]] ?? String(v)
    : term === "reviewDays" ? `${v}-day company review`
    : term === "exclusivityMonths" ? (Number(v) > 0 ? `${v} months` : "none")
    : String(v)
  const label = { engagement: "Format", ip: "IP", reviewDays: "Publication", exclusivityMonths: "Exclusivity", money: "Money" }[term]
  return `${label}: ${show(edit.from)} -> ${show(edit.to)}`
}
