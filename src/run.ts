// One-command entry (npm run demo). Live calls are recorded to fixtures/; --replay runs from them with no key.
// So far: two participants exchange one event; the Observer writes out/trace.jsonl. No LLM calls yet.
import "./env"
import { createAgent, SemanticEvent } from "@mozaik-ai/core"
import { createTraceObserver } from "./agents/observer"
import { RecordingRunner } from "./llm/runner"
import { Board, initializeRuntime, join, on, sendEvent } from "./runtime"

const runner = new RecordingRunner({ mode: process.argv.includes("--replay") ? "replay" : "record" })
initializeRuntime({ state: new Board(), inferenceRunnerConfig: { runner } })

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
