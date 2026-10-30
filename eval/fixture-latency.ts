// npm run fixture-latency -- <trace.jsonl>: adds the measured latency (`ms`) to fixtures recorded before the runner
// stored it. A fixture is matched to a loop of a live run's trace by the opening of its answer text; the latency is
// that loop's inference.started -> inference.completed (waiting for a slot and retries included, as the runner measures
// it now). A fixture is matched on both its prompt (the loop's message_received) and its answer (model.answer).
// Fixtures that already have `ms`, or that match no loop or several, are left alone and listed.
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Fixture } from "../src/llm/fixtures"

const tracePath = process.argv[2] ?? "out/trace-recording.jsonl"
const dir = "fixtures"
type Line = { t: string; type: string; loopId?: string; payload: unknown }
const lines = readFileSync(tracePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line)

const loops = new Map<string, { start?: number; end?: number; message?: string; answer?: string }>()
const text = (payload: unknown) => (typeof payload === "string" ? payload : JSON.stringify(payload))
const escaped = (s: string) => JSON.stringify(s.slice(0, 150)).slice(1, -1) // the way the trace stores text
for (const { t, type, loopId, payload } of lines) {
  if (!loopId) continue
  const loop = loops.get(loopId) ?? {}
  if (type === "inference.started") loop.start = Date.parse(t)
  if (type === "inference.completed") loop.end = Date.parse(t)
  if (type === "message_received.started") loop.message = text(payload)
  if (type === "model.answer") loop.answer = text(payload)
  loops.set(loopId, loop)
}

const unmatched: string[] = []
let added = 0
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const path = join(dir, file)
  const fixture = JSON.parse(readFileSync(path, "utf8")) as Fixture
  if (fixture.ms !== undefined) continue
  const answer = fixture.items.flatMap((item) => (item.type === "message" ? [item.content.text] : []))[0]
  if (!answer) continue
  const hits = [...loops.values()].filter((l) => l.start && l.end && l.message?.includes(escaped(fixture.prompt)) && l.answer?.includes(escaped(answer)))
  if (hits.length !== 1) {
    unmatched.push(`${file} (${fixture.model}): ${hits.length} loops`)
    continue
  }
  writeFileSync(path, JSON.stringify({ ...fixture, ms: hits[0].end! - hits[0].start! }, null, 2) + "\n")
  added++
}
console.log(`${added} fixtures got ms from ${tracePath}; ${unmatched.length} left without:`)
for (const line of unmatched) console.log(`  ${line}`)
