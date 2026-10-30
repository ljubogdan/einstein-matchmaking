// npm run demo [challengeId]: challenge -> Analyst -> BM25 shortlist -> Profiler -> pair -> negotiation -> Critic -> out/proposals/<pair>.md.
// Reuses recorded answers in fixtures/ (and parsed results in out/cache/) and calls live only for new requests (saved too).
// `-- --replay`: fixtures only, no key, no network. `-- --fresh`: every call live again.
import "./env"
import { createHuman, SemanticEvent } from "@mozaik-ai/core"
import { createAnalyst } from "./agents/analyst"
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
import { Dataset, hasDataset } from "./tools/dataset"
import { PublicationIndex } from "./tools/search"

const TIMEOUT_MS = 10 * 60_000
const mode = process.argv.includes("--replay") ? "replay" : process.argv.includes("--fresh") ? "fresh" : "record"
const [challengeId = "C001-CH1"] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))

if (!hasDataset()) {
  console.error("dataset missing: run `npm run setup` first")
  process.exit(1)
}
const data = Dataset.load()
if (!data.challenges.has(challengeId)) {
  console.error(`unknown challenge ${challengeId}`)
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

// Ends the run on the first outcome (in M3 a no-deal sends the pair back to its matchmaker instead).
const outcome = createHuman({
  name: "run",
  capabilities: ["report"],
  handlers: [
    {
      specification: on("prenup.proposal.ready"),
      processor: {
        apply: ({ event }) => {
          const { path, claims, blocked } = event.payload as { path: string; claims: number; blocked: number }
          finish(0, `proposal: ${path} (${claims} claims checked, ${blocked} blocked by the Critic)`)
        },
      },
    },
    { specification: on("prenup.negotiation.no_deal"), processor: { apply: ({ event }) => finish(0, `no deal for ${(event.payload as { pairId: string }).pairId}: ${(event.payload as { reason: string }).reason}`) } },
    {
      specification: on("prenup.nomatch"),
      processor: {
        apply: ({ event }) => {
          const { reason, nearest } = event.payload as { reason: string; nearest?: { researcherId: string; why?: string } }
          finish(0, `no match for ${challengeId}: ${reason}${nearest ? ` (nearest ${nearest.researcherId}: ${nearest.why})` : ""}`)
        },
      },
    },
    { specification: on("prenup.proposal.failed"), processor: { apply: ({ event }) => finish(1, `proposal failed: ${(event.payload as { reason: string }).reason}`) } },
    { specification: on("prenup.llm.failed"), processor: { apply: ({ event }) => finish(1, `model answer failed: ${(event.payload as { reason: string }).reason}`) } },
  ],
})

const matchmaker = createMatchmaker({
  data,
  index,
  board,
  onPair: (pair) => {
    console.log(`pair: ${pair.pairId} (picked by search)`)
    join(createNegotiator("company", pair, board, data))
    join(createNegotiator("researcher", pair, board, data))
    join(createWriter(pair, board, data))
  },
})

const cache = new ResultCache(mode !== "fresh")
join(createTraceObserver("out/trace.jsonl"))
join(createCritic({ data, move: (pairId, round) => board.move(pairId, round) }))
join(createAnalyst(data, cache))
join(createProfiler(data, cache))
join(matchmaker)
join(outcome)

// Mozaik leaves loop errors (provider error, quota, replay miss) unhandled: record them in the trace, then stop.
process.on("unhandledRejection", (error) => {
  const reason = redactKeys(String(error))
  sendEvent(SemanticEvent.create("prenup.llm.failed", outcome.getId(), { challengeId, reason }), outcome.getId())
  finish(1, `model call failed: ${reason}`)
})
setTimeout(() => finish(1, `timed out after ${TIMEOUT_MS / 60_000} minutes`), TIMEOUT_MS)

sendEvent(SemanticEvent.create("prenup.challenge.submitted", matchmaker.getId(), { challengeId }), matchmaker.getId())
