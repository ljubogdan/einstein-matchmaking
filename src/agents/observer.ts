import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { createHuman, type Human } from "@mozaik-ai/core"
import { redactKeys } from "../redact"
import { anyEvent, resolveRuntime } from "../runtime"

const MAX_PAYLOAD_CHARS = 500

/**
 * Writes every event to a JSONL trace, one line each: { t, type, producer, loopId?, payload }.
 * The board and the timeline chart are built from this file. Starts a fresh file on creation.
 */
export function createTraceObserver(path: string): Human {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, "")
  return createHuman({
    name: "observer",
    capabilities: ["trace"],
    handlers: [
      {
        specification: anyEvent(),
        processor: {
          apply: ({ event }) => {
            const producer = resolveRuntime().state.getParticipant(event.producerId)?.getManifest().name ?? event.producerId
            const loopId = (event.payload as { loopId?: string } | undefined)?.loopId
            const line = { t: event.occurredAt.toISOString(), type: event.type, producer, loopId, payload: summarize(event.payload) }
            appendFileSync(path, JSON.stringify(line) + "\n")
          },
        },
      },
    ],
  })
}

// Short payloads stay as objects; long ones (inference context) become a truncated string.
function summarize(payload: unknown): unknown {
  let text: string
  try {
    text = JSON.stringify(payload) ?? ""
  } catch {
    return "[unserializable]"
  }
  const safe = redactKeys(text) // the trace is committed and public
  if (safe.length > MAX_PAYLOAD_CHARS) return safe.slice(0, MAX_PAYLOAD_CHARS) + "…"
  return safe === "" ? undefined : JSON.parse(safe)
}
