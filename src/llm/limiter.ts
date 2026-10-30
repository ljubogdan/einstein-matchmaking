/** At most `max` tasks at once; the rest wait in order. A finishing task hands its slot straight to the next one. */
export class Semaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly max: number) {}

  async use<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active++
    else await new Promise<void>((resolve) => this.waiting.push(resolve))
    try {
      return await task()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}

/**
 * Fails a call that takes longer than `ms`. Not retried: the abandoned request keeps running and is billed,
 * so a second attempt doubles the cost of a call that is probably just long.
 */
export function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms)
  })
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer))
}

// Rate limits and provider hiccups. Anthropic, OpenAI and Google SDK errors all carry `status`.
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])

/** Retries retryable errors with exponential backoff and jitter; anything else fails at once. Reports each retry. */
export async function withRetry<T>(task: () => Promise<T>, retries: number, baseMs: number, onRetry?: (error: unknown, attempt: number) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task()
    } catch (error) {
      const status = (error as { status?: unknown }).status
      if (attempt >= retries || typeof status !== "number" || !RETRYABLE.has(status)) throw error
      onRetry?.(error, attempt + 1)
      await new Promise((resolve) => setTimeout(resolve, baseMs * 2 ** attempt * (0.5 + Math.random())))
    }
  }
}
