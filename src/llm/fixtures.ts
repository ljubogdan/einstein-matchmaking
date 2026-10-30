import { createHash } from "node:crypto"
import {
  FunctionCallItem,
  InputTokenDetails,
  ModelMessageItem,
  OutputTokenDetails,
  ReasoningItem,
  TokenUsage,
  UserMessageItem,
  type InferenceInput,
  type InferenceOutput,
} from "@mozaik-ai/core"

type InferenceItem = InferenceOutput["items"][number]

/** What we commit to fixtures/: the model's answer items, not the raw provider response. */
export type Fixture = {
  key: string
  model: string
  prompt: string // last user message, for humans reading the file
  items: FixtureItem[]
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    inputTokenDetails: { cached_tokens: number }
    outputTokenDetails: { reasoning_tokens: number }
  }
  providerUsage?: unknown // the provider's own usage block (cache writes vs reads), for cost measurement
  ms?: number // request to answer in the recording run, waiting for a slot and retries included; paced replay waits this long
}

type FixtureItem =
  | { type: "function_call"; callId: string; name: string; args: string }
  | { type: "message"; content: { text: string } }
  | ({ type: "reasoning" } & Parameters<typeof ReasoningItem.rehydrate>[0])

/**
 * Same request -> same key. Covers everything sent to the model; the context id is random per run, so it stays out.
 * Tool `invoke` functions drop out of JSON on their own.
 */
export function fixtureKey(input: InferenceInput): string {
  const request = {
    model: input.model,
    maxOutputTokens: input.maxOutputTokens,
    reasoningEffort: input.reasoningEffort,
    structuredOutput: input.structuredOutput,
    tools: (input.tools ?? []).map(({ name, description, parameters, strict }) => ({ name, description, parameters, strict })),
    items: input.context.getItems(),
  }
  return createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 16)
}

export function toFixture(key: string, input: InferenceInput, output: InferenceOutput, ms?: number): Fixture {
  const lastUser = input.context.getItems().findLast((item) => item instanceof UserMessageItem)
  const providerUsage = (output.rowResponse as { usage?: unknown; usageMetadata?: unknown } | null)?.usage ?? (output.rowResponse as { usageMetadata?: unknown } | null)?.usageMetadata
  const plain = JSON.parse(JSON.stringify({ items: output.items, tokenUsage: output.tokenUsage, providerUsage }))
  return { key, model: input.model, prompt: lastUser?.content.text.slice(0, 160) ?? "", ...plain, ms }
}

/** Rebuilds real item instances: provider mappers check `instanceof` on items when the context is sent again. */
export function fromFixture(fixture: Fixture): InferenceOutput {
  const usage = fixture.tokenUsage
  return {
    items: fixture.items.map(rehydrateItem),
    tokenUsage:
      usage &&
      new TokenUsage(
        usage.inputTokens,
        usage.outputTokens,
        usage.totalTokens,
        new InputTokenDetails(usage.inputTokenDetails.cached_tokens),
        new OutputTokenDetails(usage.outputTokenDetails.reasoning_tokens),
      ),
    rowResponse: null,
  }
}

function rehydrateItem(item: FixtureItem): InferenceItem {
  switch (item.type) {
    case "function_call":
      return FunctionCallItem.rehydrate(item)
    case "message":
      return ModelMessageItem.rehydrate({ text: item.content.text })
    case "reasoning":
      return ReasoningItem.rehydrate(item) // stores the fields as given; nothing checks the nested text classes
  }
}
