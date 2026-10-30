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

/**
 * Payload of `prenup.profile.ready`. Expertise holds only claims that passed the Critic's checks; availability,
 * engagements and flags come from code. Fit is about this challenge, never a score of the person.
 */
export type ProfileCard = {
  challengeId: string
  researcherId: string
  rank: number // 1-based position in the challenge's search shortlist
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
