import { createHuman, SemanticEvent, type Human } from "@mozaik-ai/core"
import { on, sendEvent, type Board } from "../runtime"
import type { Analysis } from "../schema/analysis"
import { FITS, type ProfileCard } from "../schema/profile"
import { makePair, type Pair } from "../tools/cards"
import type { Dataset } from "../tools/dataset"
import type { PublicationIndex } from "../tools/search"

export const SHORTLIST = 5

export type MatchmakerOptions = {
  data: Dataset
  index: PublicationIndex
  board: Board
  onPair: (pair: Pair) => void // joins the pair's negotiators and writer before the match is announced
}

/** Why a card can't be paired, or undefined if it can. Fit is per challenge; nobody is ranked as a person. */
export function exclusion(card: ProfileCard): string | undefined {
  if (card.allowedEngagements.length === 0) return `${card.availability}, no engagement type allowed`
  if (card.flags.some((f) => f.kind === "identity_conflict")) return "notes are about another person; profile can't be trusted"
  if (card.fit === "none") return `no fit: ${card.fitReason}`
  return undefined
}

/**
 * Search is code: the Analyst's terms go to BM25, the top researchers go to the Profiler, and the first card that
 * passes (strong fit before partial, then search order) is reserved and proposed. No pair -> `prenup.nomatch`.
 */
export function createMatchmaker({ data, index, board, onPair }: MatchmakerOptions): Human {
  const shortlists = new Map<string, string[]>() // challengeId -> researcher ids in search order
  const cards = new Map<string, ProfileCard[]>()

  const matchmaker: Human = createHuman({
    name: "matchmaker",
    capabilities: ["match"],
    handlers: [
      {
        specification: on("prenup.challenge.analyzed"),
        processor: {
          apply: ({ event }) => {
            const analysis = event.payload as Analysis
            const { challengeId } = analysis
            if (!analysis.researchProblem) return emit("prenup.nomatch", { challengeId, reason: `not a research problem: ${analysis.reason}` })
            const candidates = index.shortlist(analysis.searchTerms.join(" "), SHORTLIST)
            if (candidates.length === 0) return emit("prenup.nomatch", { challengeId, reason: "no publication matches the search terms" })
            shortlists.set(challengeId, candidates.map((c) => c.researcherId))
            cards.set(challengeId, [])
            emit("prenup.shortlist.ready", { challengeId, query: analysis.searchTerms, candidates })
          },
        },
      },
      {
        specification: on("prenup.profile.ready"),
        processor: {
          apply: ({ event }) => {
            const card = event.payload as ProfileCard
            const received = cards.get(card.challengeId)
            if (!received) return
            received.push(card)
            if (received.length === shortlists.get(card.challengeId)!.length) choose(card.challengeId, received)
          },
        },
      },
    ],
  })

  function choose(challengeId: string, received: ProfileCard[]): void {
    const order = shortlists.get(challengeId)!
    const ranked = [...received].sort((a, b) => FITS.indexOf(a.fit) - FITS.indexOf(b.fit) || order.indexOf(a.researcherId) - order.indexOf(b.researcherId))
    const skipped: { researcherId: string; reason: string }[] = []
    for (const card of ranked) {
      const reason = exclusion(card) ?? heldElsewhere(card.researcherId, challengeId)
      if (reason) {
        skipped.push({ researcherId: card.researcherId, reason })
        continue
      }
      // Version-checked reservation; one matchmaker here, so a lost race only happens from M3 on.
      const version = board.reservation(card.researcherId)?.version ?? 0
      if (!board.reserve(card.researcherId, challengeId, version)) {
        emit("prenup.reservation.conflict", { researcherId: card.researcherId, challengeId, version })
        skipped.push({ researcherId: card.researcherId, reason: "lost the reservation race" })
        continue
      }
      const pair = makePair(data, challengeId, card.researcherId)
      onPair(pair)
      return emit("prenup.match.proposed", {
        pairId: pair.pairId,
        challengeId,
        researcherId: card.researcherId,
        reservationVersion: version + 1,
        fit: card.fit,
        reason: card.fitReason,
        publications: card.publications,
        skipped,
      })
    }
    const nearest = order[0]
    emit("prenup.nomatch", {
      challengeId,
      reason: `none of the ${order.length} shortlisted researchers can be paired`,
      nearest: { researcherId: nearest, why: skipped.find((s) => s.researcherId === nearest)?.reason },
      skipped,
    })
  }

  function heldElsewhere(researcherId: string, challengeId: string): string | undefined {
    const held = board.reservation(researcherId)
    return held && held.challengeId !== challengeId ? `already reserved for ${held.challengeId}` : undefined
  }

  function emit(type: string, payload: unknown): void {
    sendEvent(SemanticEvent.create(type, matchmaker.getId(), payload), matchmaker.getId())
  }

  return matchmaker
}
