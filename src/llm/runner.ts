import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { defineRuntime, RuntimeState, type InferenceInput, type InferenceOutput, type InferenceRunner } from "@mozaik-ai/core"
import { fixtureKey, fromFixture, toFixture, type Fixture } from "./fixtures"
import { redactKeys } from "../redact"
import { Semaphore, withRetry, withTimeout } from "./limiter"

/**
 * replay: fixtures only, never the network. record: a saved fixture if there is one, else a live call that is saved
 * (the credit budget is small). fresh: always live, overwriting the fixture.
 */
export type RunnerMode = "replay" | "record" | "fresh"

export type RecordingRunnerOptions = {
  mode: RunnerMode
  dir?: string
  inner?: InferenceRunner // default: Mozaik's own runner
  maxInFlight?: number
  retries?: number
  retryBaseMs?: number
  timeoutMs?: number // one attempt; timeouts are not retried
  pace?: number // replayed answers wait their recorded `ms` divided by this (1 = as recorded); unset = at once
}

type Usage = { live: number; replayed: number; inputTokens: number; outputTokens: number }

/**
 * The only way our agents reach a model (AGENTS.md rule 5): record/replay, a cap on calls in flight,
 * retries with backoff, and token counts per model.
 */
export class RecordingRunner implements InferenceRunner {
  readonly mode: RunnerMode
  readonly usage = new Map<string, Usage>()
  private readonly dir: string
  private readonly limiter: Semaphore
  private readonly retries: number
  private readonly retryBaseMs: number
  private readonly timeoutMs: number
  private readonly pace: number | undefined
  private inner: InferenceRunner | undefined

  constructor(options: RecordingRunnerOptions) {
    this.mode = options.mode
    this.dir = options.dir ?? "fixtures"
    this.inner = options.inner
    this.limiter = new Semaphore(options.maxInFlight ?? 8)
    this.retries = options.retries ?? 4
    this.retryBaseMs = options.retryBaseMs ?? 1000
    this.timeoutMs = options.timeoutMs ?? 300_000
    this.pace = options.pace
  }

  async run(input: InferenceInput): Promise<InferenceOutput> {
    const key = fixtureKey(input)
    const path = join(this.dir, `${key}.json`)
    if (this.mode === "replay" && !existsSync(path)) throw new Error(`replay: no fixture ${key} for ${input.model}; run once without --replay to record it`)
    if (this.mode !== "fresh" && existsSync(path)) {
      const fixture = JSON.parse(readFileSync(path, "utf8")) as Fixture
      if (this.pace && fixture.ms) await new Promise((resolve) => setTimeout(resolve, fixture.ms! / this.pace!))
      const output = fromFixture(fixture)
      this.count(input.model, output, "replayed")
      return output
    }
    const started = Date.now()
    const inner = (this.inner ??= mozaikDefaultRunner())
    const report = (error: unknown, attempt: number) =>
      console.warn(`${input.model}: attempt ${attempt} failed (${redactKeys(String(error)).slice(0, 200)}); retrying`)
    const output = await this.limiter.use(() => withRetry(() => withTimeout(viaStream(inner, input), this.timeoutMs), this.retries, this.retryBaseMs, report))
    this.count(input.model, output, "live")
    // Thinking can use up the whole output cap and leave no answer; Mozaik would then fail with the opaque
    // "No transition rule found after inference". Fail clearly instead, and never record it (replay would repeat it).
    if (!output.items.some((item) => item.type === "message" || item.type === "function_call"))
      throw new Error(`${input.model}: no answer within ${input.maxOutputTokens} output tokens (reasoning only); not recorded. Raise MAX_OUTPUT or lower EFFORT`)
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(path, JSON.stringify(toFixture(key, input, output, Date.now() - started), null, 2) + "\n")
    return output
  }

  // Streamed calls would bypass record/replay, so they are refused rather than passed through.
  async *stream(): AsyncGenerator<never> {
    throw new Error("streaming is not recorded: leave InferenceInput.streaming off")
  }

  /** One line per model, e.g. "gemini-3.5-flash-lite: 3 live, 0 replayed, 1200 in / 40 out tokens". */
  summary(): string[] {
    return [...this.usage].map(([model, u]) => `${model}: ${u.live} live, ${u.replayed} replayed, ${u.inputTokens} in / ${u.outputTokens} out tokens`)
  }

  private count(model: string, output: InferenceOutput, kind: "live" | "replayed"): void {
    const u = this.usage.get(model) ?? { live: 0, replayed: 0, inputTokens: 0, outputTokens: 0 }
    u[kind]++
    // Anthropic leaves cache writes and reads out of input_tokens; Mozaik reports them as cached_tokens.
    u.inputTokens += (output.tokenUsage?.inputTokens ?? 0) + (output.tokenUsage?.inputTokenDetails.cached_tokens ?? 0)
    u.outputTokens += output.tokenUsage?.outputTokens ?? 0
    this.usage.set(model, u)
  }
}

/**
 * A live call sent as a stream, returned whole. Gateways drop a request whose answer doesn't start in time
 * (JigJoy's: 504 "The model didn't start answering in time"), and a non-streamed answer starts only when it's done.
 * Every Mozaik endpoint ends its stream with `inference.output`, the same output `run()` returns.
 */
async function viaStream(inner: InferenceRunner, input: InferenceInput): Promise<InferenceOutput> {
  for await (const event of inner.stream(input)) if (event.type === "inference.output") return event.payload as InferenceOutput
  throw new Error(`${input.model}: stream ended without inference.output`)
}

// Mozaik doesn't export its request validator, so the default runner is borrowed from a private runtime instance.
class ScratchState extends RuntimeState {}
function mozaikDefaultRunner(): InferenceRunner {
  return defineRuntime<ScratchState>().initializeRuntime({ state: new ScratchState() }).getInferenceRunner()
}
