import { createHuman, SemanticEvent } from "@mozaik-ai/core"
import { describe, expect, test } from "vitest"
import { createMatchmaker } from "../src/agents/matchmaker"
import { anyEvent, Board, initializeRuntime, join, sendEvent } from "../src/runtime"
import type { Fit, ProfileCard } from "../src/schema/profile"
import type { Candidate } from "../src/tools/search"
import { Dataset, hasDataset } from "../src/tools/dataset"
import { PublicationIndex } from "../src/tools/search"

// Real ids from the pinned dataset; skipped on a clone without data/einstein. No model calls: the test plays Analyst and Profiler.
describe.skipIf(!hasDataset())("matchmaker: search -> shortlist -> pair", () => {
  const data = Dataset.load()
  const board = new Board()
  initializeRuntime({ state: board })
  const events: { type: string; payload: Record<string, unknown> }[] = []
  const pairs: string[] = []
  const tester = createHuman({
    name: "tester",
    capabilities: [],
    handlers: [{ specification: anyEvent(), processor: { apply: ({ event }) => void events.push({ type: event.type, payload: event.payload as Record<string, unknown> }) } }],
  })
  join(createMatchmaker({ data, index: new PublicationIndex(data), board, onPair: (pair) => void pairs.push(pair.pairId) }))
  join(tester)
  const send = (type: string, payload: unknown) => sendEvent(SemanticEvent.create(type, tester.getId(), payload), tester.getId())
  const last = (type: string) => events.filter((e) => e.type === type).at(-1)?.payload
  const analyze = (challengeId: string) => {
    send("prenup.challenge.analyzed", { challengeId, researchProblem: true, reason: "", researchQuestions: [], searchTerms: ["unsupervised anomaly detection", "Modbus", "industrial control system network traffic"] })
    return (last("prenup.shortlist.ready") as { candidates: Candidate[] }).candidates
  }
  const card = (challengeId: string, c: Candidate, fit: Fit, overrides: Partial<ProfileCard> = {}): ProfileCard => ({
    challengeId,
    researcherId: c.researcherId,
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

  test("not a research problem: no search, a no-match with the Analyst's reason", () => {
    send("prenup.challenge.analyzed", { challengeId: "C001-CH2", researchProblem: false, reason: "it is a procurement question", researchQuestions: [], searchTerms: [] })
    expect(last("prenup.nomatch")).toMatchObject({ challengeId: "C001-CH2", reason: "not a research problem: it is a procurement question" })
  })

  test("strong fit beats partial; unavailable and identity-conflicted researchers are skipped with a reason", () => {
    const candidates = analyze("C001-CH1")
    expect(candidates).toHaveLength(5)
    const [a, b, c, d, e] = candidates
    send("prenup.profile.ready", card("C001-CH1", a, "partial"))
    send("prenup.profile.ready", card("C001-CH1", b, "strong", { availability: "unavailable", allowedEngagements: [] }))
    send("prenup.profile.ready", card("C001-CH1", c, "strong", { flags: [{ kind: "identity_conflict", detail: "" }] }))
    send("prenup.profile.ready", card("C001-CH1", d, "strong"))
    expect(last("prenup.match.proposed")).toBeUndefined() // waits for the whole shortlist
    send("prenup.profile.ready", card("C001-CH1", e, "none"))

    expect(last("prenup.match.proposed")).toMatchObject({ pairId: `C001-CH1__${d.researcherId}`, researcherId: d.researcherId, fit: "strong", reservationVersion: 1 })
    expect((last("prenup.match.proposed") as { skipped: { researcherId: string }[] }).skipped.map((s) => s.researcherId)).toEqual([b.researcherId, c.researcherId])
    expect(pairs).toEqual([`C001-CH1__${d.researcherId}`])
    expect(board.reservation(d.researcherId)).toEqual({ challengeId: "C001-CH1", version: 1 })
  })

  test("no card passes: a no-match naming the nearest candidate and why; a researcher held elsewhere is not taken", () => {
    const candidates = analyze("C001-CH3")
    for (const c of candidates) send("prenup.profile.ready", card("C001-CH3", c, c.researcherId === candidates[3].researcherId ? "strong" : "none"))
    const nomatch = last("prenup.nomatch") as { challengeId: string; nearest: { researcherId: string; why: string } }
    expect(nomatch.challengeId).toBe("C001-CH3")
    expect(nomatch.nearest.researcherId).toBe(candidates[0].researcherId)
    expect(nomatch.nearest.why).toMatch(/^no fit/)
    expect(pairs).toHaveLength(1) // candidates[3] is reserved for C001-CH1 since the last test
    expect(board.reservation(candidates[3].researcherId)?.challengeId).toBe("C001-CH1")
  })
})
