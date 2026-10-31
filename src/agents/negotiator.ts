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
import { normalize } from "../tools/normalize"
import { allowedEngagements } from "../tools/profile"
import { verifyCitations, type Evidence } from "./citations"

export const MAX_ROUNDS = 6
type Side = "company" | "researcher"

const RULES = `Each turn, answer with JSON: action (propose | accept | walk_away), sheet, reason, citations, evidence.
- propose: change at most two fields of the last sheet, and trade: give on one field to get another. accept: the other side's sheet as it is; accept as soon as it meets what your side really needs, there is no reward for using every round. walk_away: if a hard limit would be crossed, or if what is left isn't worth doing for your side; say what stopped it.
- engagement: what this problem needs, among what the researcher is open to. Start from the fit review's suggested format if your card gives one, and change it only for a reason your card states. industrial_phd: an open research question that takes years, on a topic the company will still care about in three years, at a company able to employ a candidate for 36 months (months 36, three-year milestones, company contribution includes the candidate's employment). joint_project: research both sides work on, up to 24 months. contract_research: a bounded question with an answer the company needs within a year. consulting: advice on what the company then does itself.
- scope: one sentence, at most 30 words. contributions: at most 3 items per side. backgroundIp: at most 2 short items per side. timeline: at most 4 short milestones.
- reason: one or two sentences. A citation goes in brackets right after a fact that exact line of your position card states, e.g. [C001 rd_capacity] or [SYN-PUB-00001], one per bracket. What you want is your side's position, not a fact: ownership, review days, exclusivity, rights and protections are positions. Write "we want" or "our position is" with no citation, and call it a requirement only if your card does. Don't join facts your card keeps apart (a product and a plan, say). Keep facts and positions in separate sentences: state the fact and cite it, then say what you want with no citation. Never put a citation after a reason, a trade or a benefit, and don't cite a paper or a tech list for a contract term.
- evidence: one entry per citation: citation (the text inside the brackets) and quote (words copied exactly from that line of your card, stating the fact you cite it for). If no words on that line state the fact, leave the citation out. Code removes any citation whose quote isn't on its line. citations: the same ids.
- ip, one of these Lambert Toolkit models:
${IP_MODELS.map((ip) => `  ${ip}: ${IP_LABELS[ip]}`).join("\n")}
- publication: reviewDays is 0, 30, 60 or 90 (how long the company may review a paper before it goes out); companyMayRemoveConfidential: the company may remove its confidential information, never results.
- exclusivity: a field of use and months; months 0 means none, 24 is the most either side may ask for, and if the other side lengthens it, say whether you accept and why. Consulting has none. Keep it as narrow as the company's own product, and never so wide that it would stop a thesis or the researcher's other work.
- backgroundIp: what each side keeps, with ids (patents, earlier projects, products). contributions: in kind, from the position cards; give people as roles with their time (part-time unless your card says otherwise), never a whole team.
- money says who pays for what, and "to be agreed" for how much, or names a funding route. Never an amount.
- timeline milestones are deliverables. Never say IP is transferred: the ip field says who owns what, and an option is exercised later, if at all.
- contact: roles, never a person's name, and no student unless the engagement is an industrial PhD. Use only facts from your position card.`

const INTERESTS: Record<Side, string> = {
  company: "Your interests: results you can use in your products, confidentiality of your data and know-how, a usable result within the timeline. Turn what went wrong in past collaborations into a term (milestones, a contact role).",
  researcher: "Your interests: stay inside your hard limits, keep the right to publish (see Publishing), university ownership of results, protect background IP, your own preferences in notes. Don't take on work your records don't show or your notes rule out: narrow the scope, or say which side covers it.",
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
    // One model call per move: the code above proved the words exist, this asks whether they back the statement.
    verifyCitations(`${side}-negotiator-check`, move.reason, move.evidence, (unbacked) => publish(unbacked.length ? { ...move, ...dropCitations(move, unbacked) } : move))
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
export function checkCitations(reply: { reason: string; evidence: Evidence[] }, card: string): Pick<NegotiationMove, "reason" | "citations" | "evidence" | "uncited"> {
  const lines = card.split("\n").map(normalize)
  const uncited: string[] = []
  const kept: Evidence[] = []
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
