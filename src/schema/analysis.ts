import { z } from "zod"

/** The Analyst's structured answer: a business challenge rewritten for academic search. */
export const AnalystAnswer = z.object({
  researchProblem: z.boolean(), // false: procurement, hiring, operations or anything with no open research question
  reason: z.string(),
  researchQuestions: z.array(z.string()),
  searchTerms: z.array(z.string()),
})
export type AnalystAnswer = z.infer<typeof AnalystAnswer>

/** Payload of `prenup.challenge.analyzed`. */
export const Analysis = AnalystAnswer.extend({ challengeId: z.string() })
export type Analysis = z.infer<typeof Analysis>
