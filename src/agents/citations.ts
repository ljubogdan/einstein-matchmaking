import { createAgent, type Agent } from "@mozaik-ai/core"
import { z } from "zod"
import { answerText, parseJson } from "../llm/answer"
import { EFFORT, MAX_OUTPUT, MODELS } from "../models"
import { join, own, runLoop } from "../runtime"
import { structuredOutput } from "../schema/model-schema"

export type Evidence = { citation: string; quote: string }

const CHECK_INSTRUCTION = `You check the citations in an agent's reasoning. Each numbered item gives a reason, one citation in it, and the exact words that citation rests on. Read only those words, not your own knowledge.
Find the statement the citation is attached to, usually the clause just before the bracket. Answer for each item:
- backed: true if the words state that statement (the same meaning in other words is fine). False if they are about something else or only show that a related thing exists.
- reason: one short line; "" when backed.`
const CitationCheck = z.object({ checks: z.array(z.object({ item: z.number(), backed: z.boolean(), reason: z.string() })) })

/**
 * The second half of a citation check, shared by the negotiators and the Arbiter: code has already proved each quote is
 * in the text the agent was given; one strong-model call asks whether the quote backs the statement it's cited for.
 * Calls `done` with the citations it doesn't back. An unreadable answer drops nothing: the quotes passed the code check.
 */
export function verifyCitations(name: string, reason: string, evidence: Evidence[], done: (unbacked: string[]) => void): void {
  if (evidence.length === 0) return done([])
  const checker: Agent = createAgent({
    name,
    capabilities: ["check-citations"],
    instruction: CHECK_INSTRUCTION,
    tools: [],
    handlers: [
      {
        specification: own("model.answer"),
        processor: {
          apply: ({ event }) => {
            const answer = CitationCheck.safeParse(parseJson(answerText(event.payload)))
            done(answer.success ? evidence.filter((_, i) => answer.data.checks.find((c) => c.item === i + 1)?.backed === false).map((e) => e.citation) : [])
          },
        },
      },
    ],
  })
  join(checker)
  const items = evidence.map((e, i) => `Item ${i + 1}. Reason: ${reason}\n  Citation: [${e.citation}]\n  Words: "${e.quote}"`).join("\n\n")
  runLoop(checker.getId(), items, {
    model: MODELS.strong,
    reasoningEffort: EFFORT.negotiate,
    maxOutputTokens: MAX_OUTPUT.negotiate,
    context: checker.getMemory().getContext(),
    tools: [],
    structuredOutput: structuredOutput("citation_check", CitationCheck, MODELS.strong),
  })
}
