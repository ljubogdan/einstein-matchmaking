import {
  DeveloperMessageItem,
  FunctionCallItem,
  InputTokenDetails,
  ModelContext,
  ModelMessageItem,
  OutputTokenDetails,
  ReasoningItem,
  TokenUsage,
  UserMessageItem,
  type InferenceInput,
  type InferenceOutput,
} from "@mozaik-ai/core"
import { expect, test } from "vitest"
import { fixtureKey, fromFixture, toFixture, type Fixture } from "../src/llm/fixtures"

const input = (userText: string): InferenceInput => ({
  model: "gemini-3.5-flash-lite",
  context: ModelContext.create().addContextItems([DeveloperMessageItem.create("Be brief."), UserMessageItem.create(userText)]),
  tools: [{ type: "function", name: "lookup", description: "Find a record", parameters: { type: "object" }, strict: true, invoke: async () => "" }],
})

test("the fixture key ignores the random context id and changes with the content", () => {
  expect(fixtureKey(input("Match C001-CH1"))).toBe(fixtureKey(input("Match C001-CH1")))
  expect(fixtureKey(input("Match C001-CH1"))).not.toBe(fixtureKey(input("Match C001-CH2")))
})

test("answer items survive a JSON round trip as real instances", () => {
  const reasoning = ReasoningItem.rehydrate({ content: UserMessageItem.create("thinking").content, encryptedContent: undefined, summary: [] })
  const output: InferenceOutput = {
    items: [reasoning, FunctionCallItem.rehydrate({ callId: "c1", name: "lookup", args: '{"id":"R0001"}' }), ModelMessageItem.rehydrate({ text: "OK" })],
    tokenUsage: new TokenUsage(12, 3, 15, new InputTokenDetails(0), new OutputTokenDetails(1)),
    rowResponse: { huge: "provider payload" },
  }
  const fixture = toFixture("k", input("Match C001-CH1"), output)
  const back = fromFixture(JSON.parse(JSON.stringify(fixture)) as Fixture)

  expect(fixture.prompt).toBe("Match C001-CH1")
  expect(JSON.stringify(back.items)).toBe(JSON.stringify(output.items))
  expect(back.items.map((item) => item.constructor)).toEqual([ReasoningItem, FunctionCallItem, ModelMessageItem])
  expect(back.tokenUsage).toEqual(output.tokenUsage)
  expect(JSON.stringify(fixture)).not.toContain("provider payload")
})
