import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { z } from "zod"

export const CACHE_DIR = "out/cache"

/**
 * Parsed results of model calls (analyses, profile cards), keyed by a hash of everything the model was sent.
 * Local only (gitignored): fixtures/ stay the committed record, this skips the agent when nothing changed.
 */
export class ResultCache {
  constructor(
    private readonly read: boolean, // false on --fresh: compute again, still write
    private readonly dir = CACHE_DIR,
  ) {}

  static key(...inputs: unknown[]): string {
    return createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 16)
  }

  get<T>(kind: string, name: string, key: string, schema: z.ZodType<T>): T | undefined {
    const path = this.path(kind, name, key)
    if (!this.read || !existsSync(path)) return undefined
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")))
    return parsed.success ? parsed.data : undefined
  }

  set(kind: string, name: string, key: string, value: unknown): void {
    mkdirSync(join(this.dir, kind), { recursive: true })
    writeFileSync(this.path(kind, name, key), `${JSON.stringify(value, null, 2)}\n`)
  }

  private path(kind: string, name: string, key: string): string {
    return join(this.dir, kind, `${name}-${key}.json`)
  }
}
