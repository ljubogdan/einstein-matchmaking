// Chosen models. Names must be in Mozaik's supportedModels and on the JigJoy hackathon gateway
// (ANTHROPIC_BASE_URL in .env), which serves only claude-sonnet-4-6 and claude-haiku-4-5.
export const MODELS = {
  cheap: "claude-haiku-4-5",
  strong: "claude-sonnet-4-6",
} as const

// Thinking effort per job (Anthropic output_config.effort, Gemini thinkingLevel). Left unset on gemini-3.8-flash,
// one negotiation move took 1 min 50 s (30 Oct) and the next one didn't answer within 8 minutes.
export const EFFORT = { arbitrate: "low", negotiate: "low", write: "medium", rewrite: "low" } as const

// List price in $ per million tokens (Anthropic, checked 30 Oct). The gateway bills the team's $20 from its own count.
export const PRICE: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
}

// Output cap per job, thinking included. Anthropic rejects a call without one, and Mozaik sets no default.
// write was 8000, then 16000, until 30 Oct: writers spent all of it thinking and gave no answer.
export const MAX_OUTPUT = { analyze: 1500, profile: 2000, support: 2000, arbitrate: 2000, negotiate: 4000, write: 24000, rewrite: 6000 } as const
