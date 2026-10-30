import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { defineRuntime, RuntimeState, type InferenceInput, type InferenceOutput, type InferenceRunner } from "@mozaik-ai/core"
import { fixtureKey, fromFixture, toFixture, type Fixture } from "./fixtures"
import { Semaphore, withRetry } from "./limiter"

/** record: live call, saved to fixtures. replay: fixtures only, never the network. */
export type RunnerMode = "record" | "replay"

export type RecordingRunnerOptions = {
  mode: RunnerMode
  dir?: string
  inner?: InferenceRunner // default: Mozaik's own runner
  maxInFlight?: number
  retries?: number
  retryBaseMs?: number
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
  private inner: InferenceRunner | undefined

  constructor(options: RecordingRunnerOptions) {
    this.mode = options.mode
    this.dir = options.dir ?? "fixtures"
    this.inner = options.inner
    this.limiter = new Semaphore(options.maxInFlight ?? 8)
    this.retries = options.retries ?? 4
    this.retryBaseMs = options.retryBaseMs ?? 1000
  }

  async run(input: InferenceInput): Promise<InferenceOutput> {
    const key = fixtureKey(input)
    const path = join(this.dir, `${key}.json`)
    if (this.mode === "replay") {
      if (!existsSync(path)) throw new Error(`replay: no fixture ${key} for ${input.model}; run once without --replay to record it`)
      const output = fromFixture(JSON.parse(readFileSync(path, "utf8")) as Fixture)
      this.count(input.model, output, "replayed")
      return output
    }
    const inner = (this.inner ??= mozaikDefaultRunner())
    const output = await this.limiter.use(() => withRetry(() => inner.run(input), this.retries, this.retryBaseMs))
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(path, JSON.stringify(toFixture(key, input, output), null, 2) + "\n")
    this.count(input.model, output, "live")
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
    u.inputTokens += output.tokenUsage?.inputTokens ?? 0
    u.outputTokens += output.tokenUsage?.outputTokens ?? 0
    this.usage.set(model, u)
  }
}

// Mozaik doesn't export its request validator, so the default runner is borrowed from a private runtime instance.
class ScratchState extends RuntimeState {}
function mozaikDefaultRunner(): InferenceRunner {
  return defineRuntime<ScratchState>().initializeRuntime({ state: new ScratchState() }).getInferenceRunner()
}
