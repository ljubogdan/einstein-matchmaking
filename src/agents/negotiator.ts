import { createAgent, SemanticEvent, type Agent } from "@mozaik-ai/core"
import { z } from "zod"
import { answerText, parseJson } from "../llm/answer"
import { EFFORT, MAX_OUTPUT, MODELS } from "../models"
import { join, on, own, runLoop, sendEvent, type Board } from "../runtime"
import { structuredOutput } from "../schema/model-schema"
import { IP_MODELS, NegotiationReply, REVIEW_DAYS, type NegotiationMove, type TermSheet } from "../schema/termsheet"
import { IP_LABELS } from "../proposal/terms"
import type { ProfileCard } from "../schema/profile"
import { companyCard, researcherCard, type Pair } from "../tools/cards"
import type { Dataset } from "../tools/dataset"
import { normalize } from "../tools/normalize"
import { allowedEngagements } from "../tools/profile"

export const MAX_ROUNDS = 4
type Side = "company" | "researcher"

const RULES = `Each turn, answer with JSON: action (propose | accept | walk_away), sheet, reason, citations, evidence.
- propose: change at most two fields of the last sheet, and trade: give on one field to get another. accept: the other side's sheet as it is. walk_away: only if a hard limit would be crossed.
- reason: one or two sentences. A citation goes in brackets right after a fact that exact line of your position card states, e.g. [C001 rd_capacity] or [SYN-PUB-00001], one per bracket. What you want is your side's position, not a fact: ownership, review days, exclusivity, rights and protections are positions. Write "we want" or "our position is" with no citation, and call it a requirement only if your card does. Don't join facts your card keeps apart (a product and a plan, say). Keep facts and positions in separate sentences: state the fact and cite it, then say what you want with no citation. Never put a citation after a reason, a trade or a benefit, and don't cite a paper or a tech list for a contract term.
- evidence: one entry per citation: citation (the text inside the brackets) and quote (words copied exactly from that line of your card, stating the fact you cite it for). If no words on that line state the fact, leave the citation out. Code removes any citation whose quote isn't on its line. citations: the same ids.
- ip, one of these Lambert Toolkit models:
${IP_MODELS.map((ip) => `  ${ip}: ${IP_LABELS[ip]}`).join("\n")}
- publication: reviewDays is 0, 30, 60 or 90 (how long the company may review a paper before it goes out); companyMayRemoveConfidential: the company may remove its confidential information, never results.
- exclusivity: a field of use and months; months 0 means none, 24 is the most either side may ask for, and if the other side lengthens it, say whether you accept and why.
- backgroundIp: what each side keeps, with ids (patents, earlier projects, products). contributions: in kind, from the position cards; give people as roles with their time (part-time unless your card says otherwise), never a whole team.
- money is "to be agreed" or a named funding route. Never an amount.
- timeline milestones are deliverables. Never say IP is transferred: the ip field says who owns what, and an option is exercised later, if at all.
- contact: roles, never a person's name, and no student unless the engagement is an industrial PhD. Use only facts from your position card.`

const CHECK_INSTRUCTION = `You check the citations in a negotiator's reasoning. Each numbered item gives a reason, one citation in it, and the exact words that citation rests on. Read only those words, not your own knowledge.
Find the statement the citation is attached to, usually the clause just before the bracket. Answer for each item:
- backed: true if the words state that statement (the same meaning in other words is fine). False if they are about something else or only show that a related thing exists.
- reason: one short line; "" when backed.`
const CitationCheck = z.object({ checks: z.array(z.object({ item: z.number(), backed: z.boolean(), reason: z.string() })) })

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

    const move: NegotiationMove = { ...reply, ...checkCitations(reply, card), pairId: pair.pairId, side, round: moves.length + 1, changes: previous ? changedFields(previous.sheet, reply.sheet) : [] }
    if (move.evidence.length === 0) return publish(move)
    // One model call per move: the code above proved the words exist, this asks whether they back the statement.
    const checker: Agent = createAgent({
      name: `${side}-negotiator-check`,
      capabilities: ["check-citations"],
      instruction: CHECK_INSTRUCTION,
      tools: [],
      handlers: [
        {
          specification: own("model.answer"),
          processor: {
            apply: ({ event }) => {
              // An unreadable answer leaves the citations as they are: their quotes already passed the code check.
              const answer = CitationCheck.safeParse(parseJson(answerText(event.payload)))
              const refs = answer.success ? move.evidence.filter((_, i) => answer.data.checks.find((c) => c.item === i + 1)?.backed === false).map((e) => e.citation) : []
              publish(refs.length ? { ...move, ...dropCitations(move, refs) } : move)
            },
          },
        },
      ],
    })
    join(checker)
    const items = move.evidence.map((e, i) => `Item ${i + 1}. Reason: ${move.reason}\n  Citation: [${e.citation}]\n  Words: "${e.quote}"`).join("\n\n")
    runLoop(checker.getId(), items, {
      model: MODELS.strong,
      reasoningEffort: EFFORT.negotiate,
      maxOutputTokens: MAX_OUTPUT.negotiate,
      context: checker.getMemory().getContext(),
      tools: [],
      structuredOutput: structuredOutput("citation_check", CitationCheck, MODELS.strong),
    })
  }

  function publish(move: NegotiationMove): void {
    if (cancelled()) return
    board.addMove(move)
    emit("prenup.negotiation.move", move)
    if (move.action === "accept") emit("prenup.negotiation.agreed", { pairId: pair.pairId, round: move.round, sheet: move.sheet })
    if (move.action === "walk_away") emit("prenup.negotiation.no_deal", { pairId: pair.pairId, side, reason: move.reason })
  }

  return agent
}

/** Takes these citations out of a move: the sentence stands as unsourced. Used when the check finds a quote doesn't back its statement. */
export function dropCitations(move: Pick<NegotiationMove, "reason" | "citations" | "evidence" | "uncited">, refs: string[]): Pick<NegotiationMove, "reason" | "citations" | "evidence" | "uncited"> {
  const gone = new Set(refs)
  const reason = move.reason.replace(/\s*\[([^\]]+)\]/g, (_, inner: string) => {
    const kept = inner.split(/,\s*/).map((ref) => ref.trim()).filter((ref) => !gone.has(ref))
    return kept.length ? ` [${kept.join(", ")}]` : ""
  })
  const evidence = move.evidence.filter((e) => !gone.has(e.citation))
  return { reason, evidence, citations: [...new Set(evidence.map((e) => e.citation))], uncited: [...(move.uncited ?? []), ...refs] }
}

/**
 * Keeps a citation only if its quote is on that line of the model's own position card; the card is built by code from the
 * data, so what's left can be traced to a record. Anything else loses its bracket, and the sentence stands as unsourced.
 */
export function checkCitations(reply: NegotiationReply, card: string): Pick<NegotiationMove, "reason" | "citations" | "evidence" | "uncited"> {
  const lines = card.split("\n").map(normalize)
  const uncited: string[] = []
  const kept: NegotiationReply["evidence"] = []
  const verified = (ref: string) => {
    const onLine = lines.filter((line) => line.includes(normalize(ref)))
    const found = reply.evidence.find((e) => normalize(e.citation.replace(/[[\]]/g, "")) === normalize(ref) && e.quote.trim() && onLine.some((line) => line.includes(normalize(e.quote))))
    if (found) kept.push(found)
    else uncited.push(ref)
    return !!found
  }
  const reason = reply.reason.replace(/\s*\[([^\]]+)\]/g, (_, inner: string) => {
    const refs = inner.split(/,\s*/).map((ref) => ref.trim()).filter(verified)
    return refs.length ? ` [${refs.join(", ")}]` : ""
  })
  return { reason, citations: [...new Set(kept.map((e) => e.citation))], evidence: kept, uncited }
}

function nearest(values: number[], n: number): number {
  return values.reduce((best, v) => (Math.abs(v - n) < Math.abs(best - n) ? v : best))
}

function changedFields(before: TermSheet, after: TermSheet): string[] {
  return (Object.keys(after) as (keyof TermSheet)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
}
