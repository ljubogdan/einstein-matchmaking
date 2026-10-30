import { createAgent, createHuman, SemanticEvent, type Human } from "@mozaik-ai/core"
import { z } from "zod"
import { answerText, parseJson } from "../llm/answer"
import { EFFORT, MAX_OUTPUT, MODELS } from "../models"
import { join, on, own, runLoop, sendEvent, type Board } from "../runtime"
import { structuredOutput } from "../schema/model-schema"
import type { ProfileCard } from "../schema/profile"
import type { Dataset } from "../tools/dataset"
import { pairable } from "./matchmaker"
import type { Candidate } from "../tools/search"

const INSTRUCTION = `Two company challenges want the same university researcher, who can take on only one. Decide which challenge gets the researcher.
Decide by: how well the researcher's work fits each challenge (the cards), the researcher's stated preferences (open_to, notes), and whether the other challenge has a good alternative researcher.
Never decide by the size, prestige or worth of a company or a person. Answer with JSON:
- winner: one of the two challenge ids.
- reason: two or three sentences that cite ids in brackets, e.g. [C001-CH1], [R0001], [SYN-PUB-00001]. State only what the cards say, and cite a paper only for what its card line says. Compare both cards before saying something appears on only one. If the cards don't separate the two, say it's a close call and give the researcher to the challenge that loses more search relevance by taking its alternative, stating both percentages.
- citations: those ids.`

export const ArbiterAnswer = z.object({ winner: z.string(), reason: z.string(), citations: z.array(z.string()) })

export type Decision = { researcherId: string; winner: string; loser: string; holder: string; reason: string; citations: string[]; version: number }

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
      handlers: [{ specification: own("model.answer"), processor: { apply: ({ event }) => decide(researcherId, challengeIds, answerText(event.payload), agent.getId()) } }],
    })
    join(agent)
    runLoop(agent.getId(), message(researcherId, challengeIds), {
      model: MODELS.strong,
      reasoningEffort: EFFORT.arbitrate,
      maxOutputTokens: MAX_OUTPUT.arbitrate,
      context: agent.getMemory().getContext(),
      tools: [],
      structuredOutput: structuredOutput("arbiter_decision", ArbiterAnswer, MODELS.strong),
    })
  }

  function decide(researcherId: string, challengeIds: [string, string], text: string, producerId: string): void {
    const holder = board.reservation(researcherId)!.challengeId
    const parsed = ArbiterAnswer.safeParse(parseJson(text))
    const valid = parsed.success && challengeIds.includes(parsed.data.winner)
    const answer = valid ? parsed.data : { winner: holder, reason: "the Arbiter's answer was invalid, so the current holder keeps the researcher", citations: [] }
    const winner = answer.winner
    const loser = challengeIds.find((id) => id !== winner)!
    if (winner !== holder && board.reserve(researcherId, winner, board.reservation(researcherId)!.version)) {
      const pairId = `${holder}__${researcherId}`
      board.cancelled.add(pairId)
      emit(producerId, "prenup.pair.cancelled", { pairId, reason: `the Arbiter gave ${researcherId} to ${winner}` })
    }
    emit(producerId, "prenup.arbiter.decided", { researcherId, winner, loser, holder, reason: answer.reason, citations: answer.citations, version: board.reservation(researcherId)!.version } satisfies Decision)
  }

  return arbiter
}

function emit(producerId: string, type: string, payload: unknown): void {
  sendEvent(SemanticEvent.create(type, producerId, payload), producerId)
}
