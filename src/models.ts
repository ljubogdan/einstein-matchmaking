// Chosen models. Names must be in Mozaik's supportedModels.
// Gemini free tier until the Anthropic key arrives, then claude-haiku-4-5 / claude-sonnet-5-5 (4.2.0 has no Haiku 5.x). Switch before M3.
export const MODELS = {
  cheap: "gemini-3.5-flash-lite",
  strong: "gemini-3.8-flash",
} as const
