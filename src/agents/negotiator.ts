import { createAgent, SemanticEvent, type Agent } from "@mozaik-ai/core"
import { answerText, parseJson } from "../llm/answer"
import { EFFORT, MAX_OUTPUT, MODELS } from "../models"
import { on, own, runLoop, sendEvent, type Board } from "../runtime"
import { structuredOutput } from "../schema/model-schema"
import { IP_MODELS, NegotiationReply, REVIEW_DAYS, type NegotiationMove, type TermSheet } from "../schema/termsheet"
import { IP_LABELS } from "../proposal/terms"
import type { ProfileCard } from "../schema/profile"
import { companyCard, researcherCard, type Pair } from "../tools/cards"
import type { Dataset } from "../tools/dataset"
import { allowedEngagements } from "../tools/profile"

export const MAX_ROUNDS = 4
type Side = "company" | "researcher"

const RULES = `Each turn, answer with JSON: action (propose | accept | walk_away), sheet, reason, citations.
- propose: change at most two fields of the last sheet, and trade: give on one field to get another. accept: the other side's sheet as it is. walk_away: only if a hard limit would be crossed.
- reason: one or two sentences. Cite your position card in brackets, with the field, e.g. [C001 rd_capacity] or [SYN-PUB-00001], only right after a fact that field states, one citation per bracket. Never cite a field for something it doesn't say, and don't join facts your card keeps apart (a product and a plan, say). What you want is your side's position, not a fact: write "we want" or "our position is", with no citation, and call it a requirement only if your card does. citations: those ids.
- ip, one of these Lambert Toolkit models:
${IP_MODELS.map((ip) => `  ${ip}: ${IP_LABELS[ip]}`).join("\n")}
- publication: reviewDays is 0, 30, 60 or 90 (how long the company may review a paper before it goes out); companyMayRemoveConfidential: the company may remove its confidential information, never results.
- exclusivity: a field of use and months; months 0 means none.
- backgroundIp: what each side keeps, with ids (patents, earlier projects, products). contributions: in kind, from the position cards.
- money is "to be agreed" or a named funding route. Never an amount.
- contact: roles, not names. Use only facts from your position card.`

const INTERESTS: Record<Side, string> = {
  company: "Your interests: results you can use in your products, confidentiality of your data and know-how, a usable result within the timeline. Turn what went wrong in past collaborations into a term (milestones, a contact role).",
  researcher: "Your interests: stay inside your hard limits, keep the right to publish (see Publishing), university ownership of results, protect background IP, your own preferences in notes.",
}

/**
 * One side of one pair. A fresh agent per pair and side: memory never crosses pairs or sides. Its position card is
 * built in code from the data and the Profiler's card for this pair (checked expertise, search hits, trap flags).
 */
export function createNegotiator(side: Side, pair: Pair, board: Board, data: Dataset, profile: ProfileCard): Agent {
  const other: Side = side === "company" ? "researcher" : "company"
  const card = side === "company" ? companyCard(pair, profile, data) : researcherCard(pair, profile, data)
  const allowed = allowedEngagements(pair.researcher)

  const agent: Agent = createAgent({
    name: `${side}-negotiator`,
    capabilities: ["negotiate"],
    instruction: `You negotiate for the ${side} side on challenge ${pair.challenge.id} (pair ${pair.pairId}).\n${INTERESTS[side]}\n${RULES}\n\nYour position card:\n${card}`,
    tools: [],
    handlers: [
      {
        specification: on("prenup.match.proposed"),
        processor: {
          apply: ({ event }) => {
            if (side === "company" && (event.payload as { pairId: string }).pairId === pair.pairId)
              ask(`Round 1 of ${MAX_ROUNDS}. Open with the term sheet you would prefer. action must be "propose".`)
          },
        },
      },
      {
        specification: on("prenup.negotiation.move"),
        processor: {
          apply: ({ event }) => {
            const move = event.payload as NegotiationMove
            if (move.pairId !== pair.pairId || move.side !== other || move.action !== "propose") return
            if (move.round >= MAX_ROUNDS) return emit("prenup.negotiation.no_deal", { pairId: pair.pairId, reason: `no agreement after ${MAX_ROUNDS} rounds` })
            const last = move.round + 1 === MAX_ROUNDS ? " This is the last round: accept or walk_away." : ""
            ask(`Round ${move.round + 1} of ${MAX_ROUNDS}.${last} The ${other} side proposes (${move.reason}):\n${JSON.stringify(move.sheet)}`)
          },
        },
      },
      { specification: own("model.answer"), processor: { apply: ({ event }) => record(answerText(event.payload)) } },
    ],
  })

  // A pair the Arbiter cancelled stays silent: no new rounds, and answers still in flight are dropped.
  const cancelled = () => board.cancelled.has(pair.pairId)

  function emit(type: string, payload: unknown): void {
    if (cancelled()) return
    sendEvent(SemanticEvent.create(type, agent.getId(), payload), agent.getId())
  }

  function ask(message: string): void {
    if (cancelled()) return
    runLoop(agent.getId(), message, {
      model: MODELS.strong,
      reasoningEffort: EFFORT.negotiate,
      maxOutputTokens: MAX_OUTPUT.negotiate,
      context: agent.getMemory().getContext(),
      tools: [],
      structuredOutput: structuredOutput("negotiation_move", NegotiationReply, MODELS.strong),
    })
  }

  // The model proposes; code records the move, enforces hard limits and computes what changed.
  function record(text: string): void {
    if (cancelled()) return
    const parsed = NegotiationReply.safeParse(parseJson(text))
    if (!parsed.success) return emit("prenup.negotiation.no_deal", { pairId: pair.pairId, reason: `${side} sent an invalid move: ${parsed.error.issues[0]?.message}` })
    const moves = board.negotiations.get(pair.pairId) ?? []
    const previous = moves.at(-1)
    let reply = parsed.data
    if (reply.action === "accept") reply = previous ? { ...reply, sheet: previous.sheet } : { ...reply, action: "propose" }
    reply = { ...reply, sheet: { ...reply.sheet, publication: { ...reply.sheet.publication, reviewDays: nearest(REVIEW_DAYS, reply.sheet.publication.reviewDays) } } }
    if (side === "researcher" && reply.action !== "walk_away" && !allowed.includes(reply.sheet.engagement))
      reply = { ...reply, action: "walk_away", reason: `hard limit: ${reply.sheet.engagement} is not allowed for ${pair.researcher.id} (allowed: ${allowed.join(", ") || "none"})` }

    const move: NegotiationMove = { ...reply, pairId: pair.pairId, side, round: moves.length + 1, changes: previous ? changedFields(previous.sheet, reply.sheet) : [] }
    board.addMove(move)
    emit("prenup.negotiation.move", move)
    if (move.action === "accept") emit("prenup.negotiation.agreed", { pairId: pair.pairId, round: move.round, sheet: move.sheet })
    if (move.action === "walk_away") emit("prenup.negotiation.no_deal", { pairId: pair.pairId, side, reason: move.reason })
  }

  return agent
}

function nearest(values: number[], n: number): number {
  return values.reduce((best, v) => (Math.abs(v - n) < Math.abs(best - n) ? v : best))
}

function changedFields(before: TermSheet, after: TermSheet): string[] {
  return (Object.keys(after) as (keyof TermSheet)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
}
