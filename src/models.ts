// Chosen models. Names must be in Mozaik's supportedModels and on the JigJoy hackathon gateway
// (ANTHROPIC_BASE_URL in .env), which serves only claude-sonnet-4-6 and claude-haiku-4-5.
export const MODELS = {
  cheap: "claude-haiku-4-5",
  strong: "claude-sonnet-4-6",
} as const

// Thinking effort per job (Anthropic output_config.effort, Gemini thinkingLevel). Left unset on gemini-3.8-flash,
// one negotiation move took 1 min 50 s (30 Oct) and the next one didn't answer within 8 minutes.
export const EFFORT = { negotiate: "low", write: "medium" } as const

// Output cap per job. Anthropic rejects a call without one, and Mozaik sets no default.
export const MAX_OUTPUT = { negotiate: 4000, write: 8000 } as const
