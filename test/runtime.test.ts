import { readFileSync } from "node:fs"
import { createHuman, SemanticEvent } from "@mozaik-ai/core"
import { expect, test } from "vitest"
import { createTraceObserver } from "../src/agents/observer"
import { Board, initializeRuntime, join, on, sendEvent } from "../src/runtime"

test("a custom event reaches the other participant, not its producer, and lands in the trace", () => {
  initializeRuntime({ state: new Board() })
  const tracePath = "out/tmp/trace.test.jsonl"
  const received: Array<{ by: string; payload: unknown }> = []
  const listener = (name: string) =>
    createHuman({
      name,
      capabilities: [],
      handlers: [{ specification: on("prenup.test.ping"), processor: { apply: ({ event }) => void received.push({ by: name, payload: event.payload }) } }],
    })
  const sender = listener("sender")
  join(createTraceObserver(tracePath))
  join(sender)
  join(listener("receiver"))

  sendEvent(SemanticEvent.create("prenup.test.ping", sender.getId(), { challengeId: "C001-CH1" }), sender.getId())

  expect(received).toEqual([{ by: "receiver", payload: { challengeId: "C001-CH1" } }])
  const lines = readFileSync(tracePath, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  expect(lines.find((l) => l.type === "prenup.test.ping")).toMatchObject({ producer: "sender", payload: { challengeId: "C001-CH1" } })
})
