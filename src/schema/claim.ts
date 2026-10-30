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
  problem: z.array(DraftClaim),
  researchQuestions: z.array(z.string()),
  plan: z.array(z.object({ phase: z.string(), work: z.string(), result: z.string() })),
  companyBrings: z.array(DraftClaim),
  universityBrings: z.array(DraftClaim),
  whyThisPair: z.array(DraftClaim),
})
export type Draft = z.infer<typeof Draft>
export const CLAIM_SECTIONS = ["problem", "companyBrings", "universityBrings", "whyThisPair"] as const
