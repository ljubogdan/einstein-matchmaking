import { ENGAGEMENTS, type Engagement } from "../schema/termsheet"
import type { Dataset, Researcher } from "./dataset"
import { normalize } from "./normalize"

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

/** Engagement types the researcher lists in open_to, before availability is applied. */
export function listedEngagements(r: Researcher): Engagement[] {
  return ENGAGEMENTS.filter((e) => r.open_to.some((item) => OPEN_TO[e].test(item)))
}

/** Engagement types the researcher may be offered: listed in open_to and allowed by availability. */
export function allowedEngagements(r: Researcher): Engagement[] {
  const { availability } = availabilityOf(r)
  if (availability === "unavailable") return []
  const listed = listedEngagements(r)
  return availability === "consulting_only" ? listed.filter((e) => e === "consulting") : listed
}

export type TrapKind = "unavailable" | "consulting_only" | "open_to_conflict" | "identity_conflict" | "same_name" | "low_evidence"
export type TrapFlag = { kind: TrapKind; detail: string; source?: { id: string; field: string; quote: string } }

/** The deliberate traps this profile falls into, each with the quote that shows it. Code only, no model. */
export function trapFlags(r: Researcher, data: Dataset): TrapFlag[] {
  const flags: TrapFlag[] = []
  const { availability, evidence } = availabilityOf(r)
  if (availability !== "available")
    flags.push({ kind: availability, detail: `${availability.replace("_", " ")} per ${evidence!.field}`, source: { id: r.id, ...evidence! } })
  const allowed = allowedEngagements(r)
  const dropped = listedEngagements(r).filter((e) => !allowed.includes(e))
  if (dropped.length > 0)
    flags.push({ kind: "open_to_conflict", detail: `open_to lists ${dropped.join(", ")}, but ${evidence!.field} rules it out; the stricter source wins`, source: { id: r.id, field: "open_to", quote: r.open_to.join(", ") } })
  const other = identityConflict(r, data)
  if (other) flags.push({ kind: "identity_conflict", detail: `notes are about ${other.name}, not this profile; not used as facts`, source: { id: r.id, field: "notes", quote: other.sentence } })
  const namesakes = [...data.researchers.values()].filter((o) => o.id !== r.id && normalize(o.name) === normalize(r.name)).map((o) => o.id)
  if (namesakes.length > 0) flags.push({ kind: "same_name", detail: `same name as ${namesakes.join(", ")}; joined on ids only` })
  const authored = r.publications.filter((id) => data.publications.get(id)?.authors.some((a) => a.researcher_id === r.id)).length
  if (!r.bio.trim() || authored < 2) flags.push({ kind: "low_evidence", detail: [!r.bio.trim() && "no bio", `${authored} authored publications`].filter(Boolean).join(", ") })
  return flags
}

// Notes about someone else: they open with a name from the dataset that isn't this researcher's, and never mention
// this researcher's own name. Calibrated on the full dataset (30 Oct): flags exactly R0128 ("Vesna Mitrović ...") and R0191 ("Ninkov ...").
// Supervisors and co-authors named later in the notes don't count.
const LEAD_NAME = /^(?:(?:Prof\.|Professor|Dr\.)\s+)?(\p{Lu}\p{L}+)(?:\s(\p{Lu}\p{L}+))?/u
const knownNames = new WeakMap<Dataset, Set<string>>()

function identityConflict(r: Researcher, data: Dataset): { name: string; sentence: string } | undefined {
  if (!knownNames.has(data)) knownNames.set(data, new Set([...data.researchers.values()].flatMap((o) => o.name.split(/\s+/).filter((t) => t.length >= 3))))
  const names = knownNames.get(data)!
  const notes = r.notes.trim()
  const own = r.name.split(/\s+/)
  const lead = LEAD_NAME.exec(notes)?.slice(1).filter((t): t is string => Boolean(t)) ?? []
  if (!lead.some((t) => names.has(t)) || lead.some((t) => own.includes(t)) || own.some((t) => notes.includes(t))) return undefined
  return { name: lead.join(" "), sentence: notes.split(/(?<=[.;])\s+/)[0] }
}
