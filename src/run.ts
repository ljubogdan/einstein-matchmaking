// npm run demo [challengeId ...]: 3 matchmakers split the challenges; each challenge -> Analyst -> BM25 shortlist -> Profiler
// -> reserve (version-checked; conflicts go to the Arbiter, the loser re-matches) -> negotiation from the Profiler's card -> writer
// -> Critic (deterministic checks, then a cheap-model support check; stopped claims go back once) -> out/proposals/<pair>.md.
// Reuses recorded answers in fixtures/ (and parsed results in out/cache/) and calls live only for new requests (saved too).
// `-- --replay`: fixtures only, no key, no network. `-- --fresh`: every call live again. `-- --paced[=N]`: replayed answers
// wait their recorded latency (N times faster), for the board.
import "./env"
import { createHuman, SemanticEvent } from "@mozaik-ai/core"
import { createAnalyst } from "./agents/analyst"
import { createArbiter } from "./agents/arbiter"
import { createCritic } from "./agents/critic"
import { createFitReviewer } from "./agents/fit-review"
import { createMatchmaker } from "./agents/matchmaker"
import { createNegotiator } from "./agents/negotiator"
import { createTraceObserver } from "./agents/observer"
import { createProfiler } from "./agents/profiler"
import { createReporter } from "./agents/reporter"
import { createWriter } from "./agents/writer"
import { ResultCache } from "./llm/cache"
import { RecordingRunner } from "./llm/runner"
import { redactKeys } from "./redact"
import { Board, initializeRuntime, join, on, sendEvent } from "./runtime"
import type { ProfileCard } from "./schema/profile"
import type { Pair } from "./tools/cards"
import { Dataset, hasDataset } from "./tools/dataset"
import { PublicationIndex } from "./tools/search"

const mode = process.argv.includes("--replay") ? "replay" : process.argv.includes("--fresh") ? "fresh" : "record"
// --paced[=N]: replayed answers arrive after their recorded latency (divided by N), so the trace keeps the live run's shape.
const paced = process.argv.find((arg) => arg.startsWith("--paced"))
// A replay is always paced (16x unless asked): with no waits the race leaves the recorded path and finds no fixture.
const pace = paced ? Number(paced.split("=")[1] ?? 1) || 1 : mode === "replay" ? 16 : undefined
// For measurements: --in-flight=N caps model calls at once (1 = one at a time); --fixtures=DIR records elsewhere.
const flag = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1]
const maxInFlight = Number(flag("in-flight")) || undefined
const fixtureDir = flag("fixtures")
const started = Date.now()
const TIMEOUT_MS = (Number(flag("timeout")) || 10) * 60_000 // --timeout=MINUTES
// --out=DIR: proposals, reports and the trace go there instead of out/ (runs beyond the demo set keep it intact).
const OUT = flag("out") ?? "out"
const TRACE = flag("trace") ?? `${OUT}/trace.jsonl` // the board's Run writes its own, so the committed trace stays put
// The demo set: two companies with the same challenge (C001-CH1, C032-CH1), told apart by the fit review; C061-CH1 has the
// R0128 identity-conflict profile on its shortlist; C043-CH3 (raise a seed round) is not a research problem; C022-CH3 has a
// deadline and a researcher who takes only joint projects or PhDs; C047-CH1 is an open problem with no deadline, a PhD
// candidate; C088-CH2 and C144-CH2 (membrane fouling) both need the same specialist.
const DEMO = ["C001-CH1", "C032-CH1", "C061-CH1", "C043-CH3", "C022-CH3", "C047-CH1", "C088-CH2", "C144-CH2"]
const MATCHMAKERS = 3
const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
const challengeIds = args.length > 0 ? args : DEMO

if (!hasDataset()) {
  console.error("dataset missing: run `npm run setup` first")
  process.exit(1)
}
const data = Dataset.load()
for (const id of challengeIds.filter((id) => !data.challenges.has(id))) {
  console.error(`unknown challenge ${id}`)
  process.exit(1)
}
const index = new PublicationIndex(data)
const runner = new RecordingRunner({ mode, pace, maxInFlight, dir: fixtureDir })
const board = new Board()
initializeRuntime({ state: board, inferenceRunnerConfig: { runner } })

function finish(code: number, message: string): never {
  console.log(message)
  console.log(`wall-clock: ${((Date.now() - started) / 1000).toFixed(1)} s${maxInFlight ? `, at most ${maxInFlight} model calls at once` : ""}`)
  for (const line of runner.summary()) console.log(line)
  console.log(`trace: ${TRACE}`)
  process.exit(code)
}

// One outcome per challenge: a proposal or a no-match. A proposal the Arbiter withdraws reopens its challenge.
const outcomes = new Map<string, string>()
const challengeOf = (pairId: string) => pairId.split("__")[0]
function settle(challengeId: string, line: string): void {
  outcomes.set(challengeId, line)
  console.log(line)
  if (outcomes.size < challengeIds.length) return
  reporter.write(OUT)
  finish(0, `done: ${challengeIds.length} challenges, ${[...outcomes.values()].filter((l) => l.startsWith("proposal")).length} proposals; reports: ${OUT}/nomatch.md, ${OUT}/traps.md`)
}

const outcome = createHuman({
  name: "run",
  capabilities: ["report"],
  handlers: [
    {
      specification: on("prenup.proposal.ready"),
      processor: {
        apply: ({ event }) => {
          const { pairId, path, claims, stopped, fixed, dropped } = event.payload as { pairId: string; path: string; claims: number; stopped: number; fixed: number; dropped: number }
          settle(challengeOf(pairId), `proposal: ${path} (${claims} claims checked; the Critic stopped ${stopped}, ${fixed} fixed on rewrite, ${dropped} dropped)`)
        },
      },
    },
    {
      specification: on("prenup.nomatch"),
      processor: {
        apply: ({ event }) => {
          const { challengeId, verdict, reason, nearest } = event.payload as { challengeId: string; verdict: string; reason: string; nearest?: { researcherId: string; why?: string } }
          settle(challengeId, `no match for ${challengeId} (${verdict}): ${reason}${nearest ? ` (nearest ${nearest.researcherId}: ${nearest.why})` : ""}`)
        },
      },
    },
    {
      specification: on("prenup.arbiter.decided"),
      processor: { apply: ({ event }) => void console.log(`arbiter: ${(event.payload as { researcherId: string }).researcherId} -> ${(event.payload as { winner: string }).winner}`) },
    },
    {
      specification: on("prenup.pair.cancelled"),
      processor: {
        apply: ({ event }) => {
          const { pairId, reason } = event.payload as { pairId: string; reason: string }
          if (outcomes.delete(challengeOf(pairId))) console.log(`withdrawn: ${pairId} (${reason})`)
        },
      },
    },
    { specification: on("prenup.proposal.failed"), processor: { apply: ({ event }) => finish(1, `proposal failed: ${(event.payload as { reason: string }).reason}`) } },
    { specification: on("prenup.llm.failed"), processor: { apply: ({ event }) => finish(1, `model answer failed: ${(event.payload as { reason: string }).reason}`) } },
  ],
})

const onPair = (pair: Pair, profile: ProfileCard) => {
  console.log(`pair: ${pair.pairId} (fit review: ${profile.fit})`)
  join(createNegotiator("company", pair, board, data, profile))
  join(createNegotiator("researcher", pair, board, data, profile))
  join(createWriter(pair, board, data, profile, `${OUT}/proposals`))
}
const matchmakers = Array.from({ length: Math.min(MATCHMAKERS, challengeIds.length) }, (_, i) =>
  createMatchmaker({ name: `matchmaker-${i + 1}`, challengeIds: challengeIds.filter((_, j) => j % MATCHMAKERS === i), data, index, board, onPair, reviewFit: true }),
)

const cache = new ResultCache(mode !== "fresh")
const reporter = createReporter(data)
join(createTraceObserver(TRACE))
join(createCritic({ data, move: (pairId, round) => board.move(pairId, round) }))
join(createAnalyst(data, cache))
join(createProfiler(data, cache))
join(createFitReviewer(data))
join(createArbiter(data, board))
for (const matchmaker of matchmakers) join(matchmaker)
join(reporter.participant)
join(outcome)

// Mozaik leaves loop errors (provider error, quota, replay miss) unhandled: record them in the trace, then stop.
process.on("unhandledRejection", (error) => {
  const reason = redactKeys(String(error))
  sendEvent(SemanticEvent.create("prenup.llm.failed", outcome.getId(), { reason }), outcome.getId())
  finish(1, `model call failed: ${reason}`)
})
setTimeout(() => finish(1, `timed out after ${TIMEOUT_MS / 60_000} minutes`), TIMEOUT_MS)

// Every matchmaker submits its whole slice at once: analyses, searches and profiles run concurrently.
matchmakers.forEach((matchmaker, i) => {
  for (const challengeId of challengeIds.filter((_, j) => j % MATCHMAKERS === i))
    sendEvent(SemanticEvent.create("prenup.challenge.submitted", matchmaker.getId(), { challengeId }), matchmaker.getId())
})
