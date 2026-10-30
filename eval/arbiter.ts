// npm run eval:arbiter: what the version check and the Arbiter prevent. Runs the real matchmaker code on every challenge
// in the dataset, once per arm (one Mozaik runtime per process): `versioned` is our board (read a version, write against
// it, conflicts go to an Arbiter); `--lww` is a last-writer-wins board that nobody reads and every write overwrites.
// No model: search terms are the challenge's one-line text, every Profiler card says "strong" (availability, allowed
// engagements and trap flags are the real code), cards arrive after a seeded random delay on a virtual clock so the
// matchmakers interleave the same way every run, and a stand-in Arbiter lets the holder keep the researcher.
// Writes out/eval/arbiter-<arm>.json.
import { mkdirSync, writeFileSync } from "node:fs"
import { createHuman, SemanticEvent } from "@mozaik-ai/core"
import { createMatchmaker } from "../src/agents/matchmaker"
import { Board, initializeRuntime, join, on, sendEvent, type Reservation } from "../src/runtime"
import type { ProfileCard } from "../src/schema/profile"
import { Dataset } from "../src/tools/dataset"
import { allowedEngagements, availabilityOf, trapFlags, type TrapFlag } from "../src/tools/profile"
import { PublicationIndex, type Candidate } from "../src/tools/search"

const SEED = 42
const MATCHMAKERS = 3
const MAX_DELAY = 20 // virtual ms between a shortlist and one of its cards
const ARBITER_DELAY = 5 // virtual ms for a decision
const arm = process.argv.includes("--lww") ? "last-writer-wins" : "versioned"

/** Nobody reads, every write wins: two matchmakers can both "reserve" one researcher. */
class LastWriterWins extends Board {
  override reservation(): Reservation | undefined {
    return undefined
  }
  override reserve(researcherId: string, challengeId: string): boolean {
    this.reservations.set(researcherId, { challengeId, version: (this.reservations.get(researcherId)?.version ?? 0) + 1 })
    return true
  }
}

// mulberry32: the same seed gives the same card arrival order on every run.
let state = SEED
const random = () => {
  state = (state + 0x6d2b79f5) | 0
  let t = Math.imul(state ^ (state >>> 15), 1 | state)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// A virtual clock: events wait in time order (ties in scheduling order), one per tick, so the run is the same every time.
const queue: { at: number; seq: number; run: () => void }[] = []
let now = 0
let seq = 0
const later = (delay: number, run: () => void) => queue.push({ at: now + delay, seq: seq++, run })
function drain(): void {
  if (queue.length === 0) return
  queue.sort((a, b) => a.at - b.at || a.seq - b.seq)
  const next = queue.shift()!
  now = next.at
  next.run()
  setImmediate(drain)
}

const started = Date.now()
const data = Dataset.load()
const index = new PublicationIndex(data)
const board = arm === "versioned" ? new Board() : new LastWriterWins()
initializeRuntime({ state: board })

const challengeIds = [...data.challenges.keys()].sort()
const pairOf = new Map<string, string | null>() // challengeId -> researcherId of its current pair; null = no match
let conflicts = 0
let failedWrites = 0
let rematches = 0
const flags = new Map<string, TrapFlag[]>()

const stand = createHuman({
  name: "stand-in",
  capabilities: ["profile", "arbitrate"],
  handlers: [
    {
      // Profiler stand-in: real availability, engagements and trap flags; fit "strong"; arrives after a random delay.
      specification: on("prenup.shortlist.ready"),
      processor: {
        apply: ({ event }) => {
          const { challengeId, candidates } = event.payload as { challengeId: string; candidates: Candidate[] }
          candidates.forEach((c, i) => {
            const r = data.researchers.get(c.researcherId)!
            if (!flags.has(r.id)) flags.set(r.id, trapFlags(r, data))
            const card: ProfileCard = {
              challengeId,
              researcherId: r.id,
              rank: i + 1,
              publications: c.publications.map((h) => h.id),
              availability: availabilityOf(r).availability,
              allowedEngagements: allowedEngagements(r),
              flags: flags.get(r.id)!,
              expertise: [],
              blocked: 0,
              fit: "strong",
              fitReason: "stand-in",
              cached: true,
            }
            later(random() * MAX_DELAY, () => emit("prenup.profile.ready", card))
          })
        },
      },
    },
    {
      // Arbiter stand-in: the holder keeps the researcher; the requester re-matches by itself.
      specification: on("prenup.reservation.conflict"),
      processor: {
        apply: ({ event }) => {
          const { researcherId, challengeId, holder, seenVersion, version } = event.payload as { researcherId: string; challengeId: string; holder: string; seenVersion: number; version: number }
          conflicts++
          if (version > seenVersion) failedWrites++
          later(ARBITER_DELAY, () => emit("prenup.arbiter.decided", { researcherId, winner: holder, loser: challengeId, reason: "stand-in: the holder keeps" }))
        },
      },
    },
    { specification: on("prenup.match.proposed"), processor: { apply: ({ event }) => void pairOf.set((event.payload as { challengeId: string }).challengeId, (event.payload as { researcherId: string }).researcherId) } },
    { specification: on("prenup.rematch"), processor: { apply: ({ event }) => void (rematches++, pairOf.delete((event.payload as { challengeId: string }).challengeId)) } },
    { specification: on("prenup.nomatch"), processor: { apply: ({ event }) => void pairOf.set((event.payload as { challengeId: string }).challengeId, null) } },
  ],
})
const emit = (type: string, payload: unknown) => sendEvent(SemanticEvent.create(type, stand.getId(), payload), stand.getId())

const matchmakers = Array.from({ length: MATCHMAKERS }, (_, i) =>
  createMatchmaker({ name: `matchmaker-${i + 1}`, challengeIds: challengeIds.filter((_, j) => j % MATCHMAKERS === i), data, index, board, onPair: () => {} }),
)
for (const m of matchmakers) join(m)
join(stand)

// All analyses land first (they run in parallel in a real run), so every matchmaker reads the board before anyone writes.
for (const challengeId of challengeIds)
  emit("prenup.challenge.analyzed", { challengeId, researchProblem: true, reason: "", researchQuestions: [], searchTerms: [data.challenges.get(challengeId)!.text] })

drain()

// The event loop is empty once every card has arrived and every decision has been handled.
process.on("beforeExit", () => {
  const byResearcher = new Map<string, string[]>()
  for (const [challengeId, researcherId] of pairOf) if (researcherId) byResearcher.set(researcherId, [...(byResearcher.get(researcherId) ?? []), challengeId])
  const doubleBooked = [...byResearcher].filter(([, cs]) => cs.length > 1)
  const result = {
    arm,
    what: "real matchmaker code on every challenge; stand-ins for the Analyst (one-line text as the query), Profiler (fit strong, real availability and trap flags) and Arbiter (holder keeps); no model",
    date: new Date().toISOString().slice(0, 10),
    seed: SEED,
    challenges: challengeIds.length,
    paired: [...pairOf.values()].filter(Boolean).length,
    noMatch: [...pairOf.values()].filter((r) => r === null).length,
    conflicts,
    failedWrites,
    heldWhenRead: conflicts - failedWrites,
    rematches,
    doubleBookedResearchers: doubleBooked.length,
    challengesSharingAResearcher: doubleBooked.reduce((n, [, cs]) => n + cs.length, 0),
    examples: doubleBooked.slice(0, 5).map(([researcherId, cs]) => ({ researcherId, challenges: cs })),
    seconds: (Date.now() - started) / 1000,
  }
  mkdirSync("out/eval", { recursive: true })
  writeFileSync(`out/eval/arbiter-${arm}.json`, JSON.stringify(result, null, 2) + "\n")
  console.log(`${arm}: ${result.paired} paired, ${result.noMatch} no match, ${result.conflicts} conflicts (${result.failedWrites} failed writes), ${result.rematches} re-matches, ${result.doubleBookedResearchers} double-booked researchers (${result.challengesSharingAResearcher} challenges)`)
})
