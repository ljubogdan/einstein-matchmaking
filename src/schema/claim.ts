import { z } from "zod"

export const Source = z.object({
  id: z.string(), // dataset id, or "move:<pairId>:<round>" for a negotiated term
  field: z.string(), // e.g. "abstract", or "sheet.ip" for a term
  quote: z.string(), // verbatim from that field
})
export type Source = z.infer<typeof Source>

/** Every fact any agent commits. */
export const Claim = z.object({
  id: z.string(),
  subject: z.string(), // the id the claim is about: "R0128" | "C001" | "C001-CH1" | a pair "C001-CH1__R1015"
  text: z.string(),
  sources: z.array(Source),
  kind: z.enum(["fact", "inference", "term"]),
})
export type Claim = z.infer<typeof Claim>

// The writer's claims; code adds ids, and term claims come from the term sheet, not the writer.
const DraftClaim = Claim.omit({ id: true }).extend({ kind: z.enum(["fact", "inference"]) })

/** The writer's structured answer: claims per section, plus forward-looking parts that state no facts. */
export const Draft = z.object({
  title: z.string(),
  candidate: z.string(), // industrial PhD only: who is hired, in one line; otherwise ""
  problem: z.array(DraftClaim),
  researchQuestions: z.array(z.string()),
  plan: z.array(z.object({ phase: z.string(), work: z.string(), result: z.string() })),
  companyBrings: z.array(DraftClaim),
  universityBrings: z.array(DraftClaim),
  whyThisPair: z.array(DraftClaim),
})
export type Draft = z.infer<typeof Draft>
export const CLAIM_SECTIONS = ["problem", "companyBrings", "universityBrings", "whyThisPair"] as const

/** The plan reviewer's answer: what would stop the meeting, and agreed contributions no record states. */
export const PlanReview = z.object({
  issues: z.array(z.object({ where: z.string(), problem: z.string(), fix: z.string() })),
  unconfirmed: z.array(z.string()),
})
export type PlanReview = z.infer<typeof PlanReview>

/** The writer's fix after the plan review: only the forward-looking parts change. */
export const PlanRewrite = Draft.pick({ researchQuestions: true, plan: true, candidate: true })
export type PlanRewrite = z.infer<typeof PlanRewrite>

/** The Critic's LLM support check, one entry per numbered claim: does the sentence say no more than its quotes? */
export const SupportAnswer = z.object({
  checks: z.array(z.object({ claim: z.number(), support: z.enum(["yes", "partly", "no"]), reason: z.string(), rewrite: z.string() })),
})
export type SupportAnswer = z.infer<typeof SupportAnswer>

/** A writer's or Profiler's fix for claims the Critic stopped, by the number the feedback gave them. Left out = dropped. */
export const ClaimRewrites = z.object({
  claims: z.array(z.object({ claim: z.number(), text: z.string(), sources: z.array(Source) })),
})
export type ClaimRewrites = z.infer<typeof ClaimRewrites>
