import { createAgent, createHuman, SemanticEvent, type Human } from "@mozaik-ai/core"
import { answerText, parseJson } from "../llm/answer"
import { EFFORT, MAX_OUTPUT, MODELS } from "../models"
import { join, on, own, runLoop, sendEvent } from "../runtime"
import { structuredOutput } from "../schema/model-schema"
import { FitReviewAnswer, type Fit, type ProfileCard } from "../schema/profile"
import { fieldText, type Dataset } from "../tools/dataset"
import { normalize } from "../tools/normalize"

const INSTRUCTION = `You decide who can really do a company's work. The Profiler matched researchers to a challenge on shared topics; you check whether each one could do the work the challenge needs, from the records only. This is about one piece of work, never a person's worth. Answer with JSON:
- coreWork: one sentence: what has to be built, measured or found out for this challenge to be solved, and the main skill that takes.
- reviews: one per researcher: researcherId, verdict, reason (one sentence, naming the work and the record), evidence.
- verdict "can_do": their own records show this kind of work, not only the same topic. "partly": they cover part of it; the reason names the part that is missing. "cannot": the core work is outside what their records show, or their notes rule it out. Studying the value or economics of something is not the same as building it, and a shared application area is not a shared method.
- evidence: at least one entry: id (the record's id), field (its JSON key), quote (5 to 20 consecutive words copied exactly from that field) that shows the verdict. For "cannot", quote what they do instead, or the notes that rule the work out.
- format: for "can_do" and "partly", the engagement this problem needs, one of the researcher's allowed list; otherwise "". industrial_phd: an open research question with no near deadline in the challenge, on a topic the company will still care about in three years, at a company able to employ a candidate for 36 months; when that holds and the researcher allows it, choose it. joint_project: research both sides work on, up to 24 months. contract_research: a bounded question with an answer the company needs within a year. consulting: advice on what the company then does itself.`

export type FitReview = { researcherId: string; fit: Fit; reason: string; evidence: { id: string; field: string; quote: string } []; format: string }
export type FitDone = { challengeId: string; coreWork: string; reviews: FitReview[]; check: "checked" | "failed" }

const VERDICT_FIT = { can_do: "strong", partly: "partial", cannot: "none" } as const

/** Applies a review to a card. A card nobody reviewed keeps the Profiler's fit. */
export function applyFitReview(card: ProfileCard, done: Pick<FitDone, "coreWork" | "reviews">): ProfileCard {
  const order = done.reviews.findIndex((r) => r.researcherId === card.researcherId)
  if (order < 0) return card
  const review = done.reviews[order]
  const format = review.format ? ` Suggested format: ${review.format}.` : ""
  return { ...card, fit: review.fit, fitReason: `${done.coreWork} ${review.reason}${format}`, reviewOrder: order }
}

/** What the reviewer reads: the challenge and each candidate's whole record, notes included. */
export function fitMessage(data: Dataset, challengeId: string, cards: ProfileCard[]): string {
  const challenge = data.challenges.get(challengeId)!
  const candidate = (card: ProfileCard) => {
    const r = data.researchers.get(card.researcherId)!
    const record = { id: r.id, title: r.title, department: r.department, fields: r.fields, keywords: r.keywords, bio: r.bio, industry_experience: r.industry_experience, open_to: r.open_to, allowed: card.allowedEngagements, notes: r.notes }
    const publications = card.publications.map((id) => data.publications.get(id)!).map((p) => ({ id: p.id, title: p.title, abstract: p.abstract }))
    return [JSON.stringify(record), ...publications.map((p) => JSON.stringify(p))].join("\n")
  }
  return [`Challenge ${challenge.id}: ${challenge.text}`, `Detail: ${challenge.detail}`, "", "Researchers and the publications search found for them:", ...cards.map(candidate)].join("\n")
}

/** A "cannot" takes a researcher off the challenge, so it must rest on real words: otherwise it counts as "partly". */
export function checkedVerdicts(answer: FitReviewAnswer, data: Dataset, cards: Pick<ProfileCard, "researcherId" | "allowedEngagements">[]): FitReview[] {
  const quoted = (e: FitReview["evidence"][number]) => {
    const record = data.record(e.id)
    const text = record && fieldText(record, e.field)
    return !!text && !!e.quote.trim() && normalize(text).includes(normalize(e.quote))
  }
  return answer.reviews.flatMap((r) => {
    const card = cards.find((c) => c.researcherId === r.researcherId)
    if (!card) return []
    const evidence = r.evidence.filter(quoted)
    const fit = r.verdict === "cannot" && evidence.length === 0 ? "partial" : VERDICT_FIT[r.verdict]
    // A format outside what the researcher allows is dropped here; the negotiator's hard limit would refuse it anyway.
    return [{ researcherId: r.researcherId, fit, reason: r.reason, evidence, format: card.allowedEngagements.includes(r.format as never) ? r.format : "" }]
  })
}

/**
 * On `prenup.fit.check`: a fresh strong agent per challenge reads every pairable candidate and says who could do the
 * work. Emits `prenup.fit.done`; the matchmaker applies it before reserving anyone. An unreadable answer changes nothing.
 */
export function createFitReviewer(data: Dataset): Human {
  const reviewer: Human = createHuman({
    name: "fit-reviewer",
    capabilities: ["review-fit"],
    handlers: [{ specification: on("prenup.fit.check"), processor: { apply: ({ event }) => review(event.payload as { challengeId: string; cards: ProfileCard[] }) } }],
  })

  function review({ challengeId, cards }: { challengeId: string; cards: ProfileCard[] }): void {
    const agent = createAgent({
      name: `fit-reviewer:${challengeId}`,
      capabilities: ["review-fit"],
      instruction: INSTRUCTION,
      tools: [],
      handlers: [
        {
          specification: own("model.answer"),
          processor: {
            apply: ({ event }) => {
              const parsed = FitReviewAnswer.safeParse(parseJson(answerText(event.payload)))
              const done: FitDone = parsed.success
                ? { challengeId, coreWork: parsed.data.coreWork, reviews: checkedVerdicts(parsed.data, data, cards), check: "checked" }
                : { challengeId, coreWork: "", reviews: [], check: "failed" }
              sendEvent(SemanticEvent.create("prenup.fit.done", agent.getId(), done), agent.getId())
            },
          },
        },
      ],
    })
    join(agent)
    runLoop(agent.getId(), fitMessage(data, challengeId, cards), {
      model: MODELS.strong,
      reasoningEffort: EFFORT.review,
      maxOutputTokens: MAX_OUTPUT.fitReview,
      context: agent.getMemory().getContext(),
      tools: [],
      structuredOutput: structuredOutput("fit_review", FitReviewAnswer, MODELS.strong),
    })
  }

  return reviewer
}
