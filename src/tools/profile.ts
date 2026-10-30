import { ENGAGEMENTS, type Engagement } from "../schema/termsheet"
import type { Researcher } from "./dataset"

export type Availability = "available" | "consulting_only" | "unavailable"

// Stale-profile trap: notes and bio override open_to, and the stricter source wins.
// Calibrated on R0881 ("fully retired"), R0068 ("Left the University"), R0079/R0090 (retired, consulting), R0097 (emeritus).
const UNAVAILABLE = /\bfully retired\b|\bleft the university\b|\bno longer (?:at|with|employed)\b/i
const CONSULTING_ONLY = /\bretired\b|\bemeritus\b|\bconsulting only\b/i

/** Availability from notes and bio, with the sentence that decided it. */
export function availabilityOf(r: Researcher): { availability: Availability; evidence?: { field: "notes" | "bio"; quote: string } } {
  for (const [availability, pattern] of [["unavailable", UNAVAILABLE], ["consulting_only", CONSULTING_ONLY]] as const) {
    for (const field of ["notes", "bio"] as const) {
      const sentence = r[field].split(/(?<=[.;])\s+/).find((s) => pattern.test(s))
      if (sentence) return { availability, evidence: { field, quote: sentence } }
    }
  }
  return { availability: "available" }
}

// open_to is free text ("co-supervision of industrial PhD candidates working on ..."), so it maps by keyword.
const OPEN_TO: Record<Engagement, RegExp> = {
  joint_project: /joint project/i,
  industrial_phd: /\bphd\b|doctoral/i,
  contract_research: /contract research/i,
  consulting: /consult/i,
  internship: /internship/i,
}

/** Engagement types the researcher may be offered: listed in open_to and allowed by availability. */
export function allowedEngagements(r: Researcher): Engagement[] {
  const { availability } = availabilityOf(r)
  if (availability === "unavailable") return []
  const listed = ENGAGEMENTS.filter((e) => r.open_to.some((item) => OPEN_TO[e].test(item)))
  return availability === "consulting_only" ? listed.filter((e) => e === "consulting") : listed
}
