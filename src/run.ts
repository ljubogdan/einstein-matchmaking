// One-command entry (npm run demo). M0: two participants exchange one event; the Observer writes out/trace.jsonl.
// No LLM calls yet, so --replay changes nothing until the recording runner lands in M1.
import { createAgent, SemanticEvent } from "@mozaik-ai/core"
import { createTraceObserver } from "./agents/observer"
import { Board, initializeRuntime, join, on, sendEvent } from "./runtime"

initializeRuntime({ state: new Board() })

const observer = createTraceObserver("out/trace.jsonl")
const analyst = createAgent({
  name: "analyst",
  capabilities: ["analyze-challenge"],
  instruction: "Analyze one company challenge. Cite dataset ids for every claim.",
  tools: [],
  handlers: [],
})
const matchmaker = createAgent({
  name: "matchmaker",
  capabilities: ["match"],
  instruction: "Find researchers for an analyzed challenge. Cite dataset ids for every claim.",
  tools: [],
  handlers: [
    {
      specification: on("prenup.challenge.analyzed"),
      processor: {
        apply: ({ event }) => console.log(`matchmaker received ${event.type}`, event.payload),
      },
    },
  ],
})

join(observer)
join(analyst)
join(matchmaker)

const challengeId = process.argv.find((arg) => /^C\d{3}-CH\d+$/.test(arg)) ?? "C001-CH1"
sendEvent(SemanticEvent.create("prenup.challenge.analyzed", analyst.getId(), { challengeId }), analyst.getId())
console.log("trace: out/trace.jsonl")
