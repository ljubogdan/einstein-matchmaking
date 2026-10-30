import { createAgent, createHuman, SemanticEvent, type Human } from "@mozaik-ai/core"
import { answerText, parseJson } from "../llm/answer"
import { ResultCache } from "../llm/cache"
import { MAX_OUTPUT, MODELS } from "../models"
import { join, on, own, runLoop, sendEvent } from "../runtime"
import { AnalystAnswer, type Analysis } from "../schema/analysis"
import { structuredOutput } from "../schema/model-schema"
import type { Dataset } from "../tools/dataset"

const INSTRUCTION = `You turn a company's challenge, written for customers, into what a university researcher would search for. Answer with JSON:
- researchProblem: false if there is no open research question (buying or installing a product, hiring, routine operations, paperwork, marketing); true otherwise.
- reason: one sentence on why.
- researchQuestions: 2 or 3 questions a researcher could answer, in academic language.
- searchTerms: 8 to 12 English terms or short phrases that would appear in titles, abstracts or keywords of relevant papers: methods, models, materials, domains. No company or product names.
Answer in English even if the challenge is in Serbian.`

/** The challenge as the Analyst reads it: the company's context and the challenge text, nothing about people. */
export function challengeMessage(data: Dataset, challengeId: string): string {
  const challenge = data.challenges.get(challengeId)
  const company = data.companies.get(data.challengeCompany.get(challengeId) ?? "")
  if (!challenge || !company) throw new Error(`unknown challenge ${challengeId}`)
  return [
    `Company: ${company.sector}. ${company.about}`,
    `Products: ${company.products.join("; ")}`,
    `Technology: ${company.tech.join("; ")}`,
    `Challenge ${challenge.id}: ${challenge.text}`,
    `Detail: ${challenge.detail}`,
  ].join("\n")
}

/**
 * On `prenup.challenge.submitted`: the cached analysis, or a fresh cheap agent for that challenge
 * (memory never crosses challenges). Emits `prenup.challenge.analyzed`.
 */
export function createAnalyst(data: Dataset, cache: ResultCache): Human {
  const analyst: Human = createHuman({
    name: "analyst",
    capabilities: ["analyze-challenge"],
    handlers: [
      {
        specification: on("prenup.challenge.submitted"),
        processor: { apply: ({ event }) => analyze((event.payload as { challengeId: string }).challengeId) },
      },
    ],
  })

  function analyze(challengeId: string): void {
    const message = challengeMessage(data, challengeId)
    const key = ResultCache.key(MODELS.cheap, INSTRUCTION, message)
    const cached = cache.get("analysis", challengeId, key, AnalystAnswer)
    // Next tick, like a model answer: a cached run keeps the concurrent shape (every matchmaker reads the board before anyone writes).
    if (cached) return void setImmediate(() => emit(analyst.getId(), "prenup.challenge.analyzed", { challengeId, ...cached, cached: true }))

    const agent = createAgent({
      name: `analyst:${challengeId}`,
      capabilities: ["analyze-challenge"],
      instruction: INSTRUCTION,
      tools: [],
      handlers: [
        {
          specification: own("model.answer"),
          processor: {
            apply: ({ event }) => {
              const parsed = AnalystAnswer.safeParse(parseJson(answerText(event.payload)))
              if (!parsed.success) return emit(agent.getId(), "prenup.llm.failed", { challengeId, reason: `invalid analysis: ${parsed.error.issues[0]?.message}` })
              cache.set("analysis", challengeId, key, parsed.data)
              emit(agent.getId(), "prenup.challenge.analyzed", { challengeId, ...parsed.data, cached: false } satisfies Analysis & { cached: boolean })
            },
          },
        },
      ],
    })
    join(agent)
    runLoop(agent.getId(), message, {
      model: MODELS.cheap,
      maxOutputTokens: MAX_OUTPUT.analyze,
      context: agent.getMemory().getContext(),
      tools: [],
      structuredOutput: structuredOutput("challenge_analysis", AnalystAnswer, MODELS.cheap),
    })
  }

  return analyst
}

function emit(producerId: string, type: string, payload: unknown): void {
  sendEvent(SemanticEvent.create(type, producerId, payload), producerId)
}
