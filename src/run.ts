// npm run demo [challengeId researcherId]: one pair -> negotiation -> Critic -> out/proposals/<pair>.md.
// Reuses recorded answers in fixtures/ and calls live only for new requests (saved too).
// `-- --replay`: fixtures only, no key, no network. `-- --fresh`: every call live again.
import "./env"
import { createHuman, SemanticEvent } from "@mozaik-ai/core"
import { createCritic } from "./agents/critic"
import { createNegotiator } from "./agents/negotiator"
import { createTraceObserver } from "./agents/observer"
import { createWriter } from "./agents/writer"
import { RecordingRunner } from "./llm/runner"
import { redactKeys } from "./redact"
import { Board, initializeRuntime, join, on, sendEvent } from "./runtime"
import { makePair } from "./tools/cards"
import { Dataset, hasDataset } from "./tools/dataset"

const TIMEOUT_MS = 10 * 60_000
const mode = process.argv.includes("--replay") ? "replay" : process.argv.includes("--fresh") ? "fresh" : "record"
// M1: a fixed pair (R1015 wrote "Unsupervised anomaly detection on Modbus traffic", SYN-PUB-10523). Search arrives in M2.
const [challengeId = "C001-CH1", researcherId = "R1015"] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))

if (!hasDataset()) {
  console.error("dataset missing: run `npm run setup` first")
  process.exit(1)
}
const data = Dataset.load()
const pair = makePair(data, challengeId, researcherId)
const runner = new RecordingRunner({ mode })
const board = new Board()
initializeRuntime({ state: board, inferenceRunnerConfig: { runner } })

function finish(code: number, message: string): never {
  console.log(message)
  for (const line of runner.summary()) console.log(line)
  console.log("trace: out/trace.jsonl")
  process.exit(code)
}

// The matchmaker proposes the pair and hears the outcome (in M3 it re-matches after a no-deal).
const matchmaker = createHuman({
  name: "matchmaker",
  capabilities: ["match"],
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
    { specification: on("prenup.negotiation.no_deal"), processor: { apply: ({ event }) => finish(0, `no deal for ${pair.pairId}: ${(event.payload as { reason: string }).reason}`) } },
    { specification: on("prenup.proposal.failed"), processor: { apply: ({ event }) => finish(1, `proposal failed: ${(event.payload as { reason: string }).reason}`) } },
  ],
})

join(createTraceObserver("out/trace.jsonl"))
join(createCritic({ data, move: (pairId, round) => board.move(pairId, round) }))
join(createNegotiator("company", pair, board, data))
join(createNegotiator("researcher", pair, board, data))
join(createWriter(pair, board, data))
join(matchmaker)

// Mozaik leaves loop errors (provider error, quota, replay miss) unhandled: record them in the trace, then stop.
process.on("unhandledRejection", (error) => {
  const reason = redactKeys(String(error))
  sendEvent(SemanticEvent.create("prenup.llm.failed", matchmaker.getId(), { pairId: pair.pairId, reason }), matchmaker.getId())
  finish(1, `model call failed: ${reason}`)
})
setTimeout(() => finish(1, `timed out after ${TIMEOUT_MS / 60_000} minutes`), TIMEOUT_MS)

// Reserve the researcher before proposing (one matchmaker here; in M3 the losers of this race emit a conflict).
const version = board.reservation(researcherId)?.version ?? 0
if (!board.reserve(researcherId, challengeId, version)) {
  sendEvent(SemanticEvent.create("prenup.reservation.conflict", matchmaker.getId(), { researcherId, challengeId, version }), matchmaker.getId())
  finish(1, `${researcherId} is already reserved`)
}
sendEvent(
  SemanticEvent.create("prenup.match.proposed", matchmaker.getId(), {
    pairId: pair.pairId,
    challengeId,
    researcherId,
    reservationVersion: version + 1,
    reason: "fixed pair for M1",
  }),
  matchmaker.getId(),
)
