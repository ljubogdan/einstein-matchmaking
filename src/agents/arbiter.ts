import { createAgent, createHuman, SemanticEvent, type Human } from "@mozaik-ai/core"
import { z } from "zod"
import { answerText, parseJson } from "../llm/answer"
import { EFFORT, MAX_OUTPUT, MODELS } from "../models"
import { join, on, own, runLoop, sendEvent, type Board } from "../runtime"
import { structuredOutput } from "../schema/model-schema"
import type { ProfileCard } from "../schema/profile"
import type { Dataset } from "../tools/dataset"
import { normalize } from "../tools/normalize"
import type { Candidate } from "../tools/search"
import { verifyCitations, type Evidence } from "./citations"
import { pairable } from "./matchmaker"

const IDS = /\b(?:SYN-(?:PUB|PRJ|PAT)-\d+|C\d{3}-CH\d+|C\d{3}|R\d{4})\b/g

const INSTRUCTION = `Two company challenges want the same university researcher, who can take on only one. Decide which challenge gets the researcher.
Decide by: how well the researcher's work fits each challenge (the cards), the researcher's stated preferences (open_to, notes), and whether the other challenge has a good alternative researcher.
Never decide by the size, prestige or worth of a company or a person. Answer with JSON:
- winner: one of the two challenge ids.
- reason: two or three sentences that cite ids in brackets, e.g. [C001-CH1], [R0001], [SYN-PUB-00001]. State only what the cards say, and cite a paper only for what its card line says. Compare both cards before saying something appears on only one. If the cards don't separate the two, say it's a close call and give the researcher to the challenge that loses more search relevance by taking its alternative, stating both percentages.
- citations: those ids.
- evidence: one entry per citation: citation (the text inside the brackets) and quote (words copied exactly from this message, from the part about that id, stating the fact you cite it for). Code checks the words are there, then a check reads whether they back the statement. A number in the reason must appear in this message.`

export const ArbiterAnswer = z.object({ winner: z.string(), reason: z.string(), citations: z.array(z.string()), evidence: z.array(z.object({ citation: z.string(), quote: z.string() })) })

// check: what the code and the citation check found in the reasoning. The reason stays word for word (its ids name the
// challenges and the researcher), so citations the check doesn't back are listed, not cut.
export type ReasonCheck = { cited: number; backed: number; notBacked: string[]; numbersNotInBrief: string[] }
export type Decision = { researcherId: string; winner: string; loser: string; holder: string; reason: string; citations: string[]; evidence: Evidence[]; check: ReasonCheck; version: number }

/**
 * On `prenup.reservation.conflict`: a fresh strong agent per conflict reads both challenges' cards for the researcher
 * and each side's best alternative. The board change is code: a version-checked transfer to the winner, and the
 * holder's pair cancelled if it lost. Emits `prenup.pair.cancelled` (if any), then `prenup.arbiter.decided`.
 */
export function createArbiter(data: Dataset, board: Board): Human {
  const cards = new Map<string, ProfileCard[]>() // challengeId -> every card the Profiler produced for it
  const relevance = new Map<string, Candidate[]>() // challengeId -> its search shortlist, with BM25 scores

  const arbiter: Human = createHuman({
    name: "arbiter",
    capabilities: ["arbitrate"],
    handlers: [
      {
        specification: on("prenup.shortlist.ready"),
        processor: {
          apply: ({ event }) => {
            const { challengeId, candidates } = event.payload as { challengeId: string; candidates: Candidate[] }
            relevance.set(challengeId, candidates)
          },
        },
      },
      {
        specification: on("prenup.profile.ready"),
        processor: { apply: ({ event }) => void cards.set((event.payload as ProfileCard).challengeId, [...(cards.get((event.payload as ProfileCard).challengeId) ?? []), event.payload as ProfileCard]) },
      },
      {
        specification: on("prenup.reservation.conflict"),
        processor: {
          apply: ({ event }) => {
            const { researcherId, challengeId, holder } = event.payload as { researcherId: string; challengeId: string; holder: string }
            arbitrate(researcherId, [challengeId, holder].sort() as [string, string])
          },
        },
      },
    ],
  })

  // Same text whichever matchmaker reserved first, so the recorded answer replays under any timing.
  function message(researcherId: string, challengeIds: [string, string]): string {
    const r = data.researchers.get(researcherId)!
    const side = (challengeId: string) => {
      const challenge = data.challenges.get(challengeId)!
      const company = data.companies.get(data.challengeCompany.get(challengeId)!)!
      const own = cards.get(challengeId)?.find((c) => c.researcherId === researcherId)
      const alternative = pairable(cards.get(challengeId) ?? []).find((c) => c.researcherId !== researcherId)
      const score = (id?: string) => relevance.get(challengeId)?.find((c) => c.researcherId === id)?.score
      const [mine, other] = [score(researcherId), score(alternative?.researcherId)]
      const loss = mine && other ? `  Search relevance: [${researcherId}] ${mine.toFixed(1)}, [${alternative!.researcherId}] ${other.toFixed(1)}. Taking the alternative loses ${(((mine - other) / mine) * 100).toFixed(0)}%.` : ""
      return [
        `Challenge [${challengeId}] (company [${company.id}], ${company.sector}): ${challenge.text}`,
        `  Card for [${researcherId}] on this challenge: fit ${own?.fit ?? "unknown"}. ${own?.fitReason ?? ""}`,
        ...(own?.expertise ?? []).map((c) => `  - ${c.text} [${c.sources.map((s) => s.id).join(", ")}]`),
        alternative ? `  Best alternative: [${alternative.researcherId}], fit ${alternative.fit}. ${alternative.fitReason}` : "  Best alternative: none pairable",
        ...(loss ? [loss] : []),
      ].join("\n")
    }
    return [
      `Researcher [${r.id}]: ${r.title}, ${r.department}. Open to [${r.id} open_to]: ${r.open_to.join("; ") || "none"}. Notes [${r.id} notes]: ${r.notes || "none"}`,
      "",
      ...challengeIds.map(side),
    ].join("\n")
  }

  function arbitrate(researcherId: string, challengeIds: [string, string]): void {
    const agent = createAgent({
      name: `arbiter:${researcherId}`,
      capabilities: ["arbitrate"],
      instruction: INSTRUCTION,
      tools: [],
      handlers: [{ specification: own("model.answer"), processor: { apply: ({ event }) => decide(researcherId, challengeIds, answerText(event.payload), brief, agent.getId()) } }],
    })
    join(agent)
    const brief = message(researcherId, challengeIds)
    runLoop(agent.getId(), brief, {
      model: MODELS.strong,
      reasoningEffort: EFFORT.arbitrate,
      maxOutputTokens: MAX_OUTPUT.arbitrate,
      context: agent.getMemory().getContext(),
      tools: [],
      structuredOutput: structuredOutput("arbiter_decision", ArbiterAnswer, MODELS.strong),
    })
  }

  function decide(researcherId: string, challengeIds: [string, string], text: string, brief: string, producerId: string): void {
    const holder = board.reservation(researcherId)!.challengeId
    const parsed = ArbiterAnswer.safeParse(parseJson(text))
    const valid = parsed.success && challengeIds.includes(parsed.data.winner)
    const answer = valid ? parsed.data : { winner: holder, reason: "the Arbiter's answer was invalid, so the current holder keeps the researcher", citations: [], evidence: [] }
    const winner = answer.winner
    const loser = challengeIds.find((id) => id !== winner)!
    if (winner !== holder && board.reserve(researcherId, winner, board.reservation(researcherId)!.version)) {
      const pairId = `${holder}__${researcherId}`
      board.cancelled.add(pairId)
      emit(producerId, "prenup.pair.cancelled", { pairId, reason: `the Arbiter gave ${researcherId} to ${winner}` })
    }
    // The board has moved; the reasoning is checked before it's published (and before the loser re-matches).
    const { kept, notInBrief } = quotedInBrief(brief, answer.evidence)
    const numbersNotInBrief = (answer.reason.replace(IDS, "").match(/\d+(?:[.,]\d+)*/g) ?? []).filter((n) => !normalize(brief).includes(n))
    verifyCitations(`arbiter:${researcherId}-check`, answer.reason, kept, (unbacked) => {
      const backed = kept.filter((e) => !unbacked.includes(e.citation))
      const check: ReasonCheck = { cited: answer.evidence.length, backed: backed.length, notBacked: [...notInBrief, ...unbacked], numbersNotInBrief }
      emit(producerId, "prenup.arbiter.decided", { researcherId, winner, loser, holder, reason: answer.reason, citations: answer.citations, evidence: backed, check, version: board.reservation(researcherId)!.version } satisfies Decision)
    })
  }

  return arbiter
}

/**
 * The Arbiter's brief has one part per challenge (after the researcher's line), and a challenge's id is only on that
 * part's first line. A quote counts if it is in a part that names the id it is cited for.
 */
export function quotedInBrief(brief: string, evidence: Evidence[]): { kept: Evidence[]; notInBrief: string[] } {
  const parts = brief.split(/\n(?=Challenge \[)/).map(normalize)
  const kept: Evidence[] = []
  const notInBrief: string[] = []
  for (const e of evidence) {
    const ref = normalize(e.citation.replace(/[[\]]/g, ""))
    const found = e.quote.trim() && parts.some((part) => part.includes(ref) && part.includes(normalize(e.quote)))
    if (found) kept.push(e)
    else notInBrief.push(e.citation)
  }
  return { kept, notInBrief }
}

function emit(producerId: string, type: string, payload: unknown): void {
  sendEvent(SemanticEvent.create(type, producerId, payload), producerId)
}
