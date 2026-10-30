import { createHuman, SemanticEvent } from "@mozaik-ai/core"
import { describe, expect, test } from "vitest"
import { createMatchmaker } from "../src/agents/matchmaker"
import { anyEvent, Board, initializeRuntime, join, sendEvent } from "../src/runtime"
import type { Fit, ProfileCard } from "../src/schema/profile"
import type { Candidate } from "../src/tools/search"
import { Dataset, hasDataset } from "../src/tools/dataset"
import { PublicationIndex } from "../src/tools/search"

// Real ids from the pinned dataset; skipped on a clone without data/einstein. No model calls: the test plays Analyst,
// Profiler, Arbiter and negotiators. The steps share one board, in order, like one run.
describe.skipIf(!hasDataset())("matchmakers: search -> shortlist -> reserve -> conflict -> re-match", () => {
  const data = Dataset.load()
  const board = new Board()
  initializeRuntime({ state: board })
  const events: { type: string; producer: string; payload: Record<string, unknown> }[] = []
  const pairs: string[] = []
  const tester = createHuman({
    name: "tester",
    capabilities: [],
    handlers: [{ specification: anyEvent(), processor: { apply: ({ event }) => void events.push({ type: event.type, producer: event.producerId, payload: event.payload as Record<string, unknown> }) } }],
  })
  const index = new PublicationIndex(data)
  const onPair = (pair: { pairId: string }) => void pairs.push(pair.pairId)
  const mm1 = createMatchmaker({ name: "mm-1", challengeIds: ["C001-CH1", "C001-CH2"], data, index, board, onPair })
  const mm2 = createMatchmaker({ name: "mm-2", challengeIds: ["C032-CH1"], data, index, board, onPair })
  join(mm1)
  join(mm2)
  join(tester)
  const send = (type: string, payload: unknown) => sendEvent(SemanticEvent.create(type, tester.getId(), payload), tester.getId())
  const last = (type: string, challengeId?: string) => events.filter((e) => e.type === type && (!challengeId || e.payload.challengeId === challengeId)).at(-1)?.payload
  const analyze = (challengeId: string) => {
    send("prenup.challenge.analyzed", { challengeId, researchProblem: true, reason: "", researchQuestions: [], searchTerms: ["unsupervised anomaly detection", "Modbus", "industrial control system network traffic"] })
    return (last("prenup.shortlist.ready", challengeId) as { candidates: Candidate[] }).candidates
  }
  const card = (challengeId: string, c: Candidate, rank: number, fit: Fit, overrides: Partial<ProfileCard> = {}): ProfileCard => ({
    challengeId,
    researcherId: c.researcherId,
    rank,
    publications: c.publications.map((h) => h.id),
    availability: "available",
    allowedEngagements: ["joint_project"],
    flags: [],
    expertise: [],
    blocked: 0,
    fit,
    fitReason: `[${c.publications[0].id}]`,
    cached: true,
    ...overrides,
  })
  // Same cards for both challenges: a partial, b unavailable, c notes about someone else, d strong, e partial.
  const profiles = (challengeId: string, [a, b, c, d, e]: Candidate[]) => [
    card(challengeId, a, 1, "partial"),
    card(challengeId, b, 2, "strong", { availability: "unavailable", allowedEngagements: [] }),
    card(challengeId, c, 3, "strong", { flags: [{ kind: "identity_conflict", detail: "" }] }),
    card(challengeId, d, 4, "strong"),
    card(challengeId, e, 5, "partial"),
  ]
  let candidates: Candidate[] = []
  const id = (i: number) => candidates[i].researcherId

  test("not a research problem: no search, a no-match with the Analyst's reason", () => {
    send("prenup.challenge.analyzed", { challengeId: "C001-CH2", researchProblem: false, reason: "it is a procurement question", researchQuestions: [], searchTerms: [] })
    expect(last("prenup.nomatch", "C001-CH2")).toMatchObject({ verdict: "not a research problem", reason: "it is a procurement question" })
    expect(events.filter((e) => e.type === "prenup.shortlist.ready")).toHaveLength(0)
  })

  test("each matchmaker handles only its own challenges; strong beats partial; excluded cards are skipped with reasons", () => {
    candidates = analyze("C001-CH1")
    expect(analyze("C032-CH1").map((c) => c.researcherId)).toEqual(candidates.map((c) => c.researcherId)) // both read version 0 now
    expect(events.filter((e) => e.type === "prenup.shortlist.ready").map((e) => e.producer)).toEqual([mm1.getId(), mm2.getId()])

    const cards = profiles("C001-CH1", candidates)
    for (const c of cards.slice(0, 4)) send("prenup.profile.ready", c)
    expect(last("prenup.match.proposed")).toBeUndefined() // waits for the whole shortlist
    send("prenup.profile.ready", cards[4])
    expect(last("prenup.match.proposed", "C001-CH1")).toMatchObject({ pairId: `C001-CH1__${id(3)}`, fit: "strong", reservationVersion: 1 })
    expect((last("prenup.match.proposed", "C001-CH1") as { skipped: { researcherId: string }[] }).skipped.map((s) => s.researcherId)).toEqual([id(1), id(2)])
  })

  test("the second matchmaker's write fails on the version check and becomes a conflict, not an overwrite", () => {
    for (const c of profiles("C032-CH1", candidates)) send("prenup.profile.ready", c)
    expect(last("prenup.reservation.conflict")).toEqual({ researcherId: id(3), challengeId: "C032-CH1", holder: "C001-CH1", seenVersion: 0, version: 1 })
    expect(board.reservation(id(3))).toEqual({ challengeId: "C001-CH1", version: 1 })
    expect(last("prenup.match.proposed", "C032-CH1")).toBeUndefined() // waits for the Arbiter
  })

  test("the Arbiter gives the researcher to the requester: it proposes; the holder re-matches by itself", () => {
    board.reserve(id(3), "C032-CH1", 1) // what the Arbiter writes
    board.cancelled.add(`C001-CH1__${id(3)}`)
    send("prenup.arbiter.decided", { researcherId: id(3), winner: "C032-CH1", loser: "C001-CH1", holder: "C001-CH1", reason: "fit", citations: [] })
    expect(last("prenup.match.proposed", "C032-CH1")).toMatchObject({ pairId: `C032-CH1__${id(3)}`, reservationVersion: 2 })
    expect(last("prenup.rematch", "C001-CH1")).toMatchObject({ from: id(3) })
    expect(last("prenup.match.proposed", "C001-CH1")).toMatchObject({ pairId: `C001-CH1__${id(0)}`, fit: "partial" }) // next pairable
    expect([...pairs].sort()).toEqual([`C001-CH1__${id(3)}`, `C032-CH1__${id(3)}`, `C001-CH1__${id(0)}`].sort())
  })

  test("a no-deal sends the challenge back to its matchmaker; after two negotiations it says no-match", () => {
    send("prenup.negotiation.no_deal", { pairId: `C032-CH1__${id(3)}`, reason: "publication terms" })
    // Next pairable is id(0), reserved by C001-CH1 since this matchmaker looked: the version check catches it.
    expect(last("prenup.reservation.conflict")).toMatchObject({ researcherId: id(0), challengeId: "C032-CH1", holder: "C001-CH1", seenVersion: 0, version: 1 })
    send("prenup.arbiter.decided", { researcherId: id(0), winner: "C001-CH1", loser: "C032-CH1", holder: "C001-CH1", reason: "fit", citations: [] })
    expect(last("prenup.match.proposed", "C032-CH1")).toMatchObject({ pairId: `C032-CH1__${id(4)}` })

    send("prenup.negotiation.no_deal", { pairId: `C032-CH1__${id(4)}`, reason: "exclusivity" })
    const nomatch = last("prenup.nomatch", "C032-CH1") as { verdict: string; reason: string; nearest: { researcherId: string; why: string } }
    expect(nomatch).toMatchObject({ verdict: "no deal", reason: "no deal after 2 negotiations; last: exclusivity" })
    expect(nomatch.nearest.researcherId).toBe(id(0))
    expect(nomatch.nearest.why).toMatch(/^the Arbiter gave/)
  })
})
