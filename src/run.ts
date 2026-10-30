// npm run demo [challengeId ...]: 3 matchmakers split the challenges; each challenge -> Analyst -> BM25 shortlist -> Profiler
// -> reserve (version-checked; conflicts go to the Arbiter, the loser re-matches) -> negotiation -> Critic -> out/proposals/<pair>.md.
// Reuses recorded answers in fixtures/ (and parsed results in out/cache/) and calls live only for new requests (saved too).
// `-- --replay`: fixtures only, no key, no network. `-- --fresh`: every call live again.
import "./env"
import { createHuman, SemanticEvent } from "@mozaik-ai/core"
import { createAnalyst } from "./agents/analyst"
import { createArbiter } from "./agents/arbiter"
import { createCritic } from "./agents/critic"
import { createMatchmaker } from "./agents/matchmaker"
import { createNegotiator } from "./agents/negotiator"
import { createTraceObserver } from "./agents/observer"
import { createProfiler } from "./agents/profiler"
import { createWriter } from "./agents/writer"
import { ResultCache } from "./llm/cache"
import { RecordingRunner } from "./llm/runner"
import { redactKeys } from "./redact"
import { Board, initializeRuntime, join, on, sendEvent } from "./runtime"
import type { Pair } from "./tools/cards"
import { Dataset, hasDataset } from "./tools/dataset"
import { PublicationIndex } from "./tools/search"

const TIMEOUT_MS = 10 * 60_000
const mode = process.argv.includes("--replay") ? "replay" : process.argv.includes("--fresh") ? "fresh" : "record"
// The demo set: two companies with the same challenge (C001-CH1, C032-CH1) want the same researcher; C061-CH1 has the
// R0128 identity-conflict profile on its shortlist; C043-CH3 (raise a seed round) is not a research problem.
const DEMO = ["C001-CH1", "C032-CH1", "C061-CH1", "C043-CH3"]
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
const runner = new RecordingRunner({ mode })
const board = new Board()
initializeRuntime({ state: board, inferenceRunnerConfig: { runner } })

function finish(code: number, message: string): never {
  console.log(message)
  for (const line of runner.summary()) console.log(line)
  console.log("trace: out/trace.jsonl")
  process.exit(code)
}

// One outcome per challenge: a proposal or a no-match. A proposal the Arbiter withdraws reopens its challenge.
const outcomes = new Map<string, string>()
const challengeOf = (pairId: string) => pairId.split("__")[0]
function settle(challengeId: string, line: string): void {
  outcomes.set(challengeId, line)
  console.log(line)
  if (outcomes.size === challengeIds.length) finish(0, `done: ${challengeIds.length} challenges, ${[...outcomes.values()].filter((l) => l.startsWith("proposal")).length} proposals`)
}

const outcome = createHuman({
  name: "run",
  capabilities: ["report"],
  handlers: [
    {
      specification: on("prenup.proposal.ready"),
      processor: {
        apply: ({ event }) => {
          const { pairId, path, claims, blocked } = event.payload as { pairId: string; path: string; claims: number; blocked: number }
          settle(challengeOf(pairId), `proposal: ${path} (${claims} claims checked, ${blocked} blocked by the Critic)`)
        },
      },
    },
    {
      specification: on("prenup.nomatch"),
      processor: {
        apply: ({ event }) => {
          const { challengeId, reason, nearest } = event.payload as { challengeId: string; reason: string; nearest?: { researcherId: string; why?: string } }
          settle(challengeId, `no match for ${challengeId}: ${reason}${nearest ? ` (nearest ${nearest.researcherId}: ${nearest.why})` : ""}`)
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

const onPair = (pair: Pair) => {
  console.log(`pair: ${pair.pairId} (picked by search)`)
  join(createNegotiator("company", pair, board, data))
  join(createNegotiator("researcher", pair, board, data))
  join(createWriter(pair, board, data))
}
const matchmakers = Array.from({ length: Math.min(MATCHMAKERS, challengeIds.length) }, (_, i) =>
  createMatchmaker({ name: `matchmaker-${i + 1}`, challengeIds: challengeIds.filter((_, j) => j % MATCHMAKERS === i), data, index, board, onPair }),
)

const cache = new ResultCache(mode !== "fresh")
join(createTraceObserver("out/trace.jsonl"))
join(createCritic({ data, move: (pairId, round) => board.move(pairId, round) }))
join(createAnalyst(data, cache))
join(createProfiler(data, cache))
join(createArbiter(data, board))
for (const matchmaker of matchmakers) join(matchmaker)
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
