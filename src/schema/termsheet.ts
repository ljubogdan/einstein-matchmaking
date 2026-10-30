import { z } from "zod"

export const ENGAGEMENTS = ["joint_project", "industrial_phd", "contract_research", "consulting", "internship"] as const
export type Engagement = (typeof ENGAGEMENTS)[number]

// Lambert Toolkit models: university owns (licence / option to licence / option to assign), company owns with academic use, split, contract research.
export const IP_MODELS = [
  "uni_owns_nonexclusive_licence",
  "uni_owns_option_to_licence",
  "uni_owns_option_to_assign",
  "company_owns_uni_academic_use",
  "split_by_field",
  "contract_research_company_owns",
] as const

export const REVIEW_DAYS = [0, 30, 60, 90]

// Kept to plain objects, string enums and numbers: Gemini's response schema has no unions.
// exclusivity.months 0 = no exclusivity; money is "to be agreed" or a funding route, never an amount.
export const TermSheet = z.object({
  engagement: z.enum(ENGAGEMENTS),
  scope: z.string(),
  ip: z.enum(IP_MODELS),
  exclusivity: z.object({ field: z.string(), months: z.number() }),
  publication: z.object({ reviewDays: z.number(), companyMayRemoveConfidential: z.boolean() }),
  backgroundIp: z.array(z.string()),
  contributions: z.object({ company: z.array(z.string()), university: z.array(z.string()) }),
  money: z.string(),
  timeline: z.object({ months: z.number(), milestones: z.array(z.string()) }),
  contact: z.object({ company: z.string(), university: z.string() }),
})
export type TermSheet = z.infer<typeof TermSheet>

/** What a negotiator answers each turn. */
export const NegotiationReply = z.object({
  action: z.enum(["propose", "accept", "walk_away"]),
  sheet: TermSheet,
  reason: z.string(),
  citations: z.array(z.string()),
})
export type NegotiationReply = z.infer<typeof NegotiationReply>

/** One move as recorded on the board and in the trace. `changes` is computed by code, not claimed by the model. */
export type NegotiationMove = NegotiationReply & { pairId: string; side: "company" | "researcher"; round: number; changes: string[] }
