import { supportedModels, type StructuredOutputFormat } from "@mozaik-ai/core"
import { z } from "zod"

/**
 * A zod schema as the structured-output format for one model. Gemini takes OpenAPI's schema subset,
 * which rejects `additionalProperties`; Anthropic and OpenAI strict mode need it, so it stays for them.
 */
export function structuredOutput(name: string, schema: z.ZodType, model: string): StructuredOutputFormat {
  const provider = supportedModels.find((m) => m.specification.name === model)?.specification.provider
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  delete json.$schema
  return { name, schema: provider === "google" ? withoutKey(json, "additionalProperties") : json, strict: true }
}

function withoutKey(value: unknown, key: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (k, v) => (k === key ? undefined : v)))
}
