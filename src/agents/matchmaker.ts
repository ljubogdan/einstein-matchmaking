import { createHuman, SemanticEvent, type Human } from "@mozaik-ai/core"
import { on, sendEvent, type Board } from "../runtime"
import type { Analysis } from "../schema/analysis"
import { FITS, type ProfileCard } from "../schema/profile"
import { makePair, type Pair } from "../tools/cards"
import type { Dataset } from "../tools/dataset"
import type { PublicationIndex } from "../tools/search"

export const SHORTLIST = 5
export type NomatchVerdict = "not a research problem" | "no good match" | "match exists but unavailable" | "no deal"
export const MAX_NEGOTIATIONS = 2 // per challenge: after this many no-deals the matchmaker says no-match

export type MatchmakerOptions = {
  name: string
  challengeIds: string[] // the slice of challenges this matchmaker owns
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

/** Cards in the order a matchmaker tries them: pairable only, strong fit before partial, then search order. */
export function pairable(cards: ProfileCard[]): ProfileCard[] {
  return cards.filter((c) => !exclusion(c)).sort((a, b) => FITS.indexOf(a.fit) - FITS.indexOf(b.fit) || a.rank - b.rank)
}

type Slot = {
  size: number // shortlist length
  cards: ProfileCard[]
  seen: Map<string, number> // researcherId -> reservation version read when the shortlist was made
  tried: Map<string, string> // researcherId -> why it isn't (or is no longer) this challenge's pair
  waitingFor?: string // researcher under arbitration
  pair?: Pair
  negotiations: number
}

/**
 * Owns a slice of challenges. Search is code: the Analyst's terms go to BM25, the top researchers go to the Profiler,
 * and the first pairable card is reserved with the version read at shortlist time. A failed write (another matchmaker
 * reserved first) or a researcher held elsewhere becomes `prenup.reservation.conflict`; on the Arbiter's decision the
 * loser re-matches by itself, as it does after a no-deal. Nothing left -> `prenup.nomatch`.
 */
export function createMatchmaker({ name, challengeIds, data, index, board, onPair }: MatchmakerOptions): Human {
  const mine = new Set(challengeIds)
  const slots = new Map<string, Slot>()

  const matchmaker: Human = createHuman({
    name,
    capabilities: ["match"],
    handlers: [
      {
        specification: on("prenup.challenge.analyzed"),
        processor: { apply: ({ event }) => void (mine.has((event.payload as Analysis).challengeId) && shortlist(event.payload as Analysis)) },
      },
      {
        specification: on("prenup.profile.ready"),
        processor: {
          apply: ({ event }) => {
            const card = event.payload as ProfileCard
            const slot = slots.get(card.challengeId)
            if (!mine.has(card.challengeId) || !slot) return
            slot.cards.push(card)
            if (slot.cards.length === slot.size) choose(card.challengeId)
          },
        },
      },
      {
        specification: on("prenup.arbiter.decided"),
        processor: {
          apply: ({ event }) => {
            const { researcherId, winner, loser, reason } = event.payload as { researcherId: string; winner: string; loser: string; reason: string }
            if (mine.has(loser)) rematch(loser, researcherId, `the Arbiter gave ${researcherId} to ${winner}: ${reason}`)
            const slot = slots.get(winner)
            if (mine.has(winner) && slot?.waitingFor === researcherId) {
              slot.waitingFor = undefined
              propose(winner, slot.cards.find((c) => c.researcherId === researcherId)!, board.reservation(researcherId)!.version)
            }
          },
        },
      },
      {
        specification: on("prenup.negotiation.no_deal"),
        processor: {
          apply: ({ event }) => {
            const { pairId, reason } = event.payload as { pairId: string; reason: string }
            const [challengeId, researcherId] = pairId.split("__")
            const slot = slots.get(challengeId)
            if (!mine.has(challengeId) || slot?.pair?.pairId !== pairId || board.cancelled.has(pairId)) return
            if (slot.negotiations >= MAX_NEGOTIATIONS) return nomatch(challengeId, "no deal", `no deal after ${slot.negotiations} negotiations; last: ${reason}`)
            rematch(challengeId, researcherId, `no deal: ${reason}`)
          },
        },
      },
    ],
  })

  function shortlist(analysis: Analysis): void {
    const { challengeId } = analysis
    if (!analysis.researchProblem) return emit("prenup.nomatch", { challengeId, verdict: "not a research problem", reason: analysis.reason })
    const candidates = index.shortlist(analysis.searchTerms.join(" "), SHORTLIST)
    if (candidates.length === 0) return emit("prenup.nomatch", { challengeId, verdict: "no good match", reason: "no publication matches the search terms" })
    // The read half of the version-checked write: remember what the board said now; reserve against it later.
    const seen = new Map(candidates.map((c) => [c.researcherId, board.reservation(c.researcherId)?.version ?? 0]))
    slots.set(challengeId, { size: candidates.length, cards: [], seen, tried: new Map(), negotiations: 0 })
    emit("prenup.shortlist.ready", { challengeId, query: analysis.searchTerms, candidates })
  }

  function choose(challengeId: string): void {
    const slot = slots.get(challengeId)!
    const card = pairable(slot.cards).find((c) => !slot.tried.has(c.researcherId))
    if (!card) {
      const fitsButUnavailable = slot.cards.some((c) => c.fit !== "none" && c.allowedEngagements.length === 0)
      return nomatch(challengeId, fitsButUnavailable ? "match exists but unavailable" : "no good match", `none of the ${slot.size} shortlisted researchers can be paired`)
    }
    const held = board.reservation(card.researcherId)
    const seen = slot.seen.get(card.researcherId) ?? 0
    // Already held when we looked: contest it instead of overwriting.
    if (held && held.version === seen && held.challengeId !== challengeId) return conflict(challengeId, card.researcherId, seen, held.challengeId)
    // The version check: fails if another matchmaker reserved since we looked.
    if (!board.reserve(card.researcherId, challengeId, seen)) return conflict(challengeId, card.researcherId, seen, board.reservation(card.researcherId)!.challengeId)
    propose(challengeId, card, seen + 1)
  }

  // Lost the race (or the researcher was already held): the Arbiter decides; this matchmaker waits for its event.
  function conflict(challengeId: string, researcherId: string, seenVersion: number, holder: string): void {
    slots.get(challengeId)!.waitingFor = researcherId
    emit("prenup.reservation.conflict", { researcherId, challengeId, holder, seenVersion, version: board.reservation(researcherId)!.version })
  }

  function propose(challengeId: string, card: ProfileCard, version: number): void {
    const slot = slots.get(challengeId)!
    const pair = makePair(data, challengeId, card.researcherId)
    slot.pair = pair
    slot.negotiations += 1
    onPair(pair)
    emit("prenup.match.proposed", {
      pairId: pair.pairId,
      challengeId,
      researcherId: card.researcherId,
      reservationVersion: version,
      fit: card.fit,
      reason: card.fitReason,
      publications: card.publications,
      skipped: skipped(slot),
    })
  }

  function rematch(challengeId: string, researcherId: string, reason: string): void {
    const slot = slots.get(challengeId)!
    slot.tried.set(researcherId, reason)
    slot.waitingFor = undefined
    slot.pair = undefined
    emit("prenup.rematch", { challengeId, from: researcherId, reason })
    choose(challengeId)
  }

  function nomatch(challengeId: string, verdict: NomatchVerdict, reason: string): void {
    const slot = slots.get(challengeId)!
    const nearest = [...slot.cards].sort((a, b) => a.rank - b.rank)[0]
    emit("prenup.nomatch", { challengeId, verdict, reason, nearest: { researcherId: nearest.researcherId, why: slot.tried.get(nearest.researcherId) ?? exclusion(nearest) }, skipped: skipped(slot) })
  }

  function skipped(slot: Slot): { researcherId: string; reason: string }[] {
    const excluded = slot.cards.flatMap((c) => (exclusion(c) ? [{ researcherId: c.researcherId, reason: exclusion(c)! }] : []))
    return [...excluded, ...[...slot.tried].map(([researcherId, reason]) => ({ researcherId, reason }))]
  }

  function emit(type: string, payload: unknown): void {
    sendEvent(SemanticEvent.create(type, matchmaker.getId(), payload), matchmaker.getId())
  }

  return matchmaker
}
