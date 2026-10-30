import { readdirSync, rmSync } from "node:fs"
import { ModelContext, ModelMessageItem, SemanticEvent, UserMessageItem, type InferenceInput, type InferenceOutput, type InferenceRunner } from "@mozaik-ai/core"
import { beforeEach, expect, test } from "vitest"
import { Semaphore, withRetry } from "../src/llm/limiter"
import { RecordingRunner } from "../src/llm/runner"

const dir = "out/tmp/fixtures-test"
const input = (text: string): InferenceInput => ({ model: "gemini-3.5-flash-lite", context: ModelContext.create().addContextItem(UserMessageItem.create(text)) })
const answer = (text: string): InferenceOutput => ({ items: [ModelMessageItem.rehydrate({ text })], tokenUsage: undefined, rowResponse: null })
// Like Mozaik's endpoints: the stream ends with `inference.output`. The runner only ever streams.
const fakeModel = (run: InferenceRunner["run"]): InferenceRunner => ({
  run: () => Promise.reject(new Error("the runner should stream")),
  stream: async function* (input) {
    yield SemanticEvent.create("inference.output", input.model, await run(input))
  },
})

beforeEach(() => rmSync(dir, { recursive: true, force: true }))

test("record saves the answer; replay returns it without calling the model, and fails clearly on a miss", async () => {
  let calls = 0
  const recorder = new RecordingRunner({ mode: "record", dir, inner: fakeModel(async () => (calls++, answer("OK"))) })
  await recorder.run(input("Reply OK"))
  expect(readdirSync(dir)).toHaveLength(1)

  const replayer = new RecordingRunner({ mode: "replay", dir, inner: fakeModel(async () => { throw new Error("network used in replay") }) })
  const replayed = await replayer.run(input("Reply OK"))
  expect(replayed.items[0]).toBeInstanceOf(ModelMessageItem)
  expect(JSON.stringify(replayed.items)).toBe(JSON.stringify(answer("OK").items))
  expect(calls).toBe(1)
  expect(replayer.summary()).toEqual(["gemini-3.5-flash-lite: 0 live, 1 replayed, 0 in / 0 out tokens"])
  await expect(replayer.run(input("Something else"))).rejects.toThrow(/no fixture/)
})

test("rate limits and server errors are retried; other errors fail at once", async () => {
  let attempts = 0
  const flaky = async () => {
    if (++attempts < 3) throw Object.assign(new Error("slow down"), { status: 429 })
    return "ok"
  }
  await expect(withRetry(flaky, 4, 1)).resolves.toBe("ok")
  expect(attempts).toBe(3)

  let badCalls = 0
  const bad = async () => {
    badCalls++
    throw Object.assign(new Error("bad key"), { status: 401 })
  }
  await expect(withRetry(bad, 4, 1)).rejects.toThrow("bad key")
  expect(badCalls).toBe(1)
})

test("record reuses a saved answer; fresh always calls the model again", async () => {
  let calls = 0
  const model = fakeModel(async () => (calls++, answer("OK")))
  await new RecordingRunner({ mode: "record", dir, inner: model }).run(input("Reply OK"))
  await new RecordingRunner({ mode: "record", dir, inner: model }).run(input("Reply OK"))
  expect(calls).toBe(1)
  await new RecordingRunner({ mode: "fresh", dir, inner: model }).run(input("Reply OK"))
  expect(calls).toBe(2)
})

test("a call that never answers times out once and is not retried (the abandoned call is still billed)", async () => {
  let attempts = 0
  const hung = new RecordingRunner({ mode: "fresh", dir, retries: 3, retryBaseMs: 1, timeoutMs: 20, inner: fakeModel(() => (attempts++, new Promise(() => {}))) })
  await expect(hung.run(input("Reply OK"))).rejects.toThrow(/no answer within/)
  expect(attempts).toBe(1)
})

test("the semaphore never runs more than its limit at once", async () => {
  const limiter = new Semaphore(2)
  let active = 0
  let peak = 0
  const task = () =>
    limiter.use(async () => {
      peak = Math.max(peak, ++active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
    })
  await Promise.all(Array.from({ length: 6 }, task))
  expect(peak).toBe(2)
})
