import type { Claim } from "../schema/claim"
import type { Engagement, NegotiationMove, TermSheet } from "../schema/termsheet"

export const ENGAGEMENT_LABELS: Record<Engagement, string> = {
  industrial_phd: "Industrial PhD",
  joint_project: "Joint project",
  contract_research: "Contract research",
  consulting: "Consulting",
  internship: "Internship",
}

const IP_LABELS: Record<TermSheet["ip"], string> = {
  uni_owns_nonexclusive_licence: "the university owns the results; the company gets a non-exclusive licence",
  uni_owns_option_to_licence: "the university owns the results; the company has an option to license them",
  uni_owns_option_to_assign: "the university owns the results; the company has an option to take them over",
  company_owns_uni_academic_use: "the company owns the results; the university keeps the right to use them for research and teaching",
  split_by_field: "ownership is split by field of use",
  contract_research_company_owns: "contract research: the company owns the results",
}

/**
 * "Agreed up front" as term claims, built from the accepted move only. Each quotes exactly what the Critic reads
 * from that move, so numbers in the sentence must come from the sheet.
 */
export function termClaims(move: NegotiationMove, researcherId: string): Claim[] {
  const s = move.sheet
  const term = (key: keyof TermSheet, text: string, subject = move.pairId): Claim => {
    const value = s[key]
    const quote = typeof value === "string" ? value : JSON.stringify(value)
    return { id: `${move.pairId}/terms/${key}`, subject, kind: "term", text, sources: [{ id: `move:${move.pairId}:${move.round}`, field: `sheet.${key}`, quote }] }
  }
  const { exclusivity: x, publication: p, timeline: t } = s
  return [
    term("engagement", `Format: ${ENGAGEMENT_LABELS[s.engagement]}`, researcherId),
    term("scope", `Scope: ${s.scope}`),
    term("ip", `IP: ${IP_LABELS[s.ip]}.`),
    term(
      "publication",
      `Publication: papers go out after a ${p.reviewDays}-day company review${p.companyMayRemoveConfidential ? "; the company may remove its confidential information, not results" : ""}.`,
    ),
    term("exclusivity", x.months > 0 ? `Exclusivity: ${x.months} months in ${x.field}.` : "Exclusivity: none."),
    term("backgroundIp", `Background IP: ${s.backgroundIp.join("; ") || "none declared"}.`),
    term("contributions", `Contributions: company: ${s.contributions.company.join("; ") || "none"}; university: ${s.contributions.university.join("; ") || "none"}.`),
    term("money", `Money: ${s.money}.`),
    term("timeline", `Timeline: ${t.months} months${t.milestones.length ? `; milestones: ${t.milestones.join("; ")}` : ""}.`),
    term("contact", `Contacts: ${s.contact.company} (company) and ${s.contact.university} (university).`),
  ]
}
