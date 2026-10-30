// npm run eval:timeline [-- <trace.jsonl> [name]]: the concurrency timeline of a run, from its trace. One row per kind of
// participant, one bar per model call (inference.started -> inference.completed, waiting for a slot included).
// Default trace: out/trace-recording.jsonl, the live recording run. Writes out/eval/<name>.svg and <name>.json
// (name defaults to "timeline").
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"

const tracePath = process.argv[2] ?? "out/trace-recording.jsonl"
const name = process.argv[3] ?? "timeline"
const GROUPS: [string, RegExp][] = [
  ["Analysts", /^analyst/],
  ["Profilers", /^profiler/],
  ["Critic support check", /^critic/],
  ["Arbiter", /^arbiter/],
  ["Negotiators", /negotiator$/],
  ["Writers", /^writer/],
]
type Line = { t: string; type: string; producer: string; loopId?: string }
const lines = readFileSync(tracePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line)

const loops = new Map<string, { group: string; start: number; end?: number }>()
for (const { t, type, producer, loopId } of lines) {
  if (!loopId) continue
  const group = GROUPS.find(([, re]) => re.test(producer))?.[0]
  if (type === "inference.started" && group) loops.set(loopId, { group, start: Date.parse(t) })
  if (type === "inference.completed" && loops.has(loopId)) loops.get(loopId)!.end = Date.parse(t)
}
const calls = [...loops.values()].filter((l) => l.end !== undefined) as { group: string; start: number; end: number }[]
const t0 = Date.parse(lines[0].t)
const t1 = Date.parse(lines.at(-1)!.t)
const span = (t1 - t0) / 1000

// Calls open at once: sweep over start (+1) and end (-1) points.
const points = calls.flatMap((c) => [[c.start, 1], [c.end, -1]] as [number, number][]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
let open = 0
let peak = 0
for (const [, d] of points) peak = Math.max(peak, (open += d))
const callSeconds = calls.reduce((s, c) => s + (c.end - c.start) / 1000, 0)

const stats = {
  trace: tracePath,
  calls: calls.length,
  wallClockSeconds: Number(span.toFixed(1)),
  sumOfCallSeconds: Number(callSeconds.toFixed(1)),
  averageOpenCalls: Number((callSeconds / span).toFixed(2)),
  peakOpenCalls: peak,
  byGroup: Object.fromEntries(GROUPS.map(([g]) => [g, calls.filter((c) => c.group === g).length]).filter(([, n]) => n)),
  note: "A call's time includes waiting for one of the runner's 8 slots and retries after 429s, so the sum of call times is not the time one-at-a-time calls would take.",
}

// The chart: lanes per group so overlapping calls stack.
const W = 900
const LABEL = 150
const x = (t: number) => LABEL + ((t - t0) / 1000 / span) * (W - LABEL - 10)
const parts: string[] = []
let y = 22
for (const [g] of GROUPS) {
  const mine = calls.filter((c) => c.group === g).sort((a, b) => a.start - b.start)
  if (mine.length === 0) continue
  const ends: number[] = []
  const bars = mine.map((c) => {
    let lane = ends.findIndex((e) => e <= c.start)
    if (lane === -1) lane = ends.push(c.end) - 1
    else ends[lane] = c.end
    return { ...c, lane }
  })
  const h = ends.length * 5 + 8
  parts.push(`<text x="0" y="${y + h / 2 + 4}" font-size="12" fill="#1d2330">${g} <tspan fill="#6b7280">${mine.length}</tspan></text>`)
  parts.push(`<rect x="${LABEL}" y="${y}" width="${W - LABEL - 10}" height="${h}" fill="#f7f8fa"/>`)
  for (const b of bars) parts.push(`<rect x="${x(b.start).toFixed(1)}" y="${y + 4 + b.lane * 5}" width="${Math.max(x(b.end) - x(b.start), 1.5).toFixed(1)}" height="4" fill="#2457c5"/>`)
  y += h + 6
}
const step = span > 120 ? 30 : span > 40 ? 10 : 5
for (let s = 0; s <= span; s += step) parts.unshift(`<line x1="${x(t0 + s * 1000)}" x2="${x(t0 + s * 1000)}" y1="16" y2="${y}" stroke="#e3e6ec"/><text x="${x(t0 + s * 1000) + 2}" y="12" font-size="10" fill="#6b7280">${s}s</text>`)
const title = `${stats.calls} model calls in ${stats.wallClockSeconds} s; up to ${stats.peakOpenCalls} open at once`
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y + 24}" viewBox="0 0 ${W} ${y + 24}" font-family="system-ui, sans-serif">
<rect width="100%" height="100%" fill="#ffffff"/>
${parts.join("\n")}
<text x="0" y="${y + 16}" font-size="11" fill="#6b7280">${title}. One bar per model call, from ${tracePath.split("/").pop()}.</text>
</svg>
`
mkdirSync("out/eval", { recursive: true })
writeFileSync(`out/eval/${name}.svg`, svg)
writeFileSync(`out/eval/${name}.json`, JSON.stringify(stats, null, 2) + "\n")
console.log(JSON.stringify(stats, null, 2))
