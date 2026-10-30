/** The text of a `model.answer` event: payload `{ answer: { content: { text } } }`. */
export function answerText(payload: unknown): string {
  return (payload as { answer?: { content?: { text?: string } } }).answer?.content?.text ?? ""
}

/** Structured output is JSON; tolerate a model that wraps it in prose or a code fence. */
export function parseJson(text: string): unknown {
  for (const candidate of [text, /\{[\s\S]*\}/.exec(text)?.[0]]) {
    try {
      if (candidate) return JSON.parse(candidate)
    } catch {
      // try the next form
    }
  }
  return undefined
}
