import { z } from "zod"
import type { Availability, TrapFlag } from "../tools/profile"
import { Claim, Source } from "./claim"
import type { Engagement } from "./termsheet"

export const FITS = ["strong", "partial", "none"] as const
export type Fit = (typeof FITS)[number]

/** The Profiler's structured answer: what one researcher's records say, read against one challenge. */
export const ProfilerAnswer = z.object({
  expertise: z.array(z.object({ text: z.string(), sources: z.array(Source) })),
  fit: z.enum(FITS),
  fitReason: z.string(),
})
export type ProfilerAnswer = z.infer<typeof ProfilerAnswer>

/** The fit reviewer's structured answer: who could do the work this challenge needs, each with the words that show it. */
export const FitReviewAnswer = z.object({
  coreWork: z.string(),
  reviews: z.array(z.object({ researcherId: z.string(), verdict: z.enum(["can_do", "partly", "cannot"]), reason: z.string(), evidence: z.array(Source), format: z.string() })),
})
export type FitReviewAnswer = z.infer<typeof FitReviewAnswer>

/**
 * Payload of `prenup.profile.ready`. Expertise holds only claims that passed the Critic's checks; availability,
 * engagements and flags come from code. Fit is about this challenge, never a score of the person.
 */
export type ProfileCard = {
  challengeId: string
  researcherId: string
  rank: number // 1-based position in the challenge's search shortlist
  reviewOrder?: number // position in the fit reviewer's answer: it decides between equal fits, instead of search order
  publications: string[] // the search hits the Profiler read
  availability: Availability
  allowedEngagements: Engagement[]
  flags: TrapFlag[]
  expertise: Claim[]
  blocked: number
  fit: Fit
  fitReason: string
  cached: boolean
}
