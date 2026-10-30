// npm run check-key: one live call through our runner proves the provider key in .env works and records the answer.
// npm run check-key -- --replay: the same call from that recording, no network. Not part of the demo.
import "./env"
import { createAgent, createHuman, supportedModels } from "@mozaik-ai/core"
import { createTraceObserver } from "./agents/observer"
import { RecordingRunner } from "./llm/runner"
import { MODELS } from "./models"
import { redactKeys } from "./redact"
import { Board, initializeRuntime, join, on, runLoop } from "./runtime"

const TIMEOUT_MS = 60_000
const KEY_VARS: Record<string, string> = { google: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" }

function fail(reason: string): never {
  console.error(`key check failed: ${redactKeys(reason)}`)
  process.exit(1)
}

const replay = process.argv.includes("--replay")
if (!replay) {
  const provider = supportedModels.find((m) => m.specification.name === MODELS.cheap)?.specification.provider ?? ""
  const keyVar = KEY_VARS[provider] ?? fail(`no key variable known for ${MODELS.cheap} (provider "${provider}")`)
  if (!process.env[keyVar]) fail(`${keyVar} is empty or missing in .env`)
  if (provider === "anthropic") console.log(`endpoint: ${process.env.ANTHROPIC_BASE_URL ? new URL(process.env.ANTHROPIC_BASE_URL).host : "api.anthropic.com"}`)
}

// Mozaik doesn't catch loop errors (bad key, quota): they surface as unhandled rejections.
process.on("unhandledRejection", (error) => fail(String(error)))
const timer = setTimeout(() => fail(`no answer within ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS)

const runner = new RecordingRunner({ mode: replay ? "replay" : "fresh", dir: "out/tmp/fixtures" }) // a key check must really call
initializeRuntime({ state: new Board(), inferenceRunnerConfig: { runner } })
const agent = createAgent({ name: "key-check", capabilities: [], instruction: "Answer in one word.", tools: [], handlers: [] })
const listener = createHuman({
  name: "key-check-listener",
  capabilities: [],
  handlers: [
    {
      specification: on("model.answer"),
      processor: {
        apply: ({ event }) => {
          clearTimeout(timer)
          console.log(`${replay ? "replay works" : "key works"}: ${MODELS.cheap} answered ${redactKeys(JSON.stringify(event.payload)).slice(0, 200)}`)
          console.log(runner.summary().join("\n"))
          process.exit(0)
        },
      },
    },
  ],
})

join(createTraceObserver("out/tmp/key-check.jsonl"))
join(agent)
join(listener)
runLoop(agent.getId(), "Reply with the word OK.", {
  model: MODELS.cheap,
  context: agent.getMemory().getContext(),
  tools: agent.getTools(),
  maxOutputTokens: 256,
})
