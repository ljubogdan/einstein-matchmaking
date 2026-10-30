// Loads .env into process.env when it exists. Import first in every entry point.
// Non-empty .env values win over inherited ones: agent shells (Claude Code, Cursor) export their own ANTHROPIC_BASE_URL,
// which would silently send the gateway key to the wrong endpoint. Empty lines in .env are ignored.
// Replay runs and fresh clones have no .env, so a missing file is fine.
import { readFileSync } from "node:fs"
import { parseEnv } from "node:util"

let file = ""
try {
  file = readFileSync(".env", "utf8")
} catch {
  // no .env
}
for (const [name, value] of Object.entries(parseEnv(file))) if (value) process.env[name] = value

// With no key, Mozaik's telemetry client warns once per model loop (86 lines in a replay). One line says it.
const warn = console.warn
let warned = false
console.warn = (...args: unknown[]) => {
  if (String(args[0]).startsWith("mozaik cloud: no API key")) {
    if (warned) return
    warned = true
  }
  warn(...args)
}
