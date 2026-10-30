// npm run board: the live board at http://localhost:4173. It follows the newest trace as a run writes it and sends each
// line to the page (Server-Sent Events). "Run" starts `src/run.ts --replay --paced=N` with its own trace file, so the
// committed out/trace.jsonl stays as it is: the agents run again on the recorded answers, each answer arriving after its
// recorded latency divided by N. No key, no network. A run started in a terminal (out/trace.jsonl) shows up too.
// "Plant false claims" starts the Critic test (eval/critic.ts): 20 planted claims, checked as one writer draft would be.
import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { Dataset, hasDataset } from "../tools/dataset"

const PORT = Number(process.env.PORT ?? 4173)
const TRACES = ["out/trace.jsonl", "out/tmp/trace.board.jsonl"] // a terminal run, the board's Run
let TRACE = TRACES[0]
const PAGE = "src/board/index.html"
const HEAD_BYTES = 64 // the first line starts with its timestamp: a changed head means a new run rewrote the file

// The current run's trace, as complete lines. A new run truncates the file; followers then get "reset".
let lines: string[] = []
let offset = 0
let head = ""
let rest = Buffer.alloc(0)
const clients = new Set<ServerResponse>()
type Scene = "demo" | "plant"
let run: { child: ChildProcess; speed: number; scene: Scene } | undefined
let data: Dataset | undefined

function send(res: ServerResponse, event: string, payload: string): void {
  res.write(`event: ${event}\ndata: ${payload}\n\n`)
}

function broadcast(event: string, payload: string): void {
  for (const res of clients) send(res, event, payload)
}

function read(from: number, length: number): Buffer {
  const fd = openSync(TRACE, "r")
  try {
    const buffer = Buffer.alloc(length)
    const n = readSync(fd, buffer, 0, length, from)
    return buffer.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

// Follow whichever trace was written last; switching files is a reset like a new run.
function newest(): string {
  const mtime = (path: string) => (existsSync(path) ? statSync(path).mtimeMs : -1)
  return TRACES.reduce((a, b) => (mtime(b) > mtime(a) ? b : a))
}

function poll(): void {
  const latest = newest()
  if (latest !== TRACE) {
    TRACE = latest
    offset = 0
    head = ""
    lines = []
    rest = Buffer.alloc(0)
    broadcast("reset", "{}")
  }
  if (!existsSync(TRACE)) return
  const size = statSync(TRACE).size
  const currentHead = size > 0 ? read(0, Math.min(HEAD_BYTES, size)).toString("utf8") : ""
  if (size < offset || (head && !currentHead.startsWith(head.slice(0, Math.min(head.length, currentHead.length))))) {
    lines = []
    offset = 0
    rest = Buffer.alloc(0)
    broadcast("reset", "{}")
  }
  head = currentHead
  if (size === offset) return
  // Bytes, not strings: a read can end inside a line or a multi-byte character; only whole lines go out.
  const chunk = Buffer.concat([rest, read(offset, size - offset)])
  offset = size
  const end = chunk.lastIndexOf(0x0a)
  rest = chunk.subarray(end + 1)
  for (const line of chunk.subarray(0, end + 1).toString("utf8").split("\n")) {
    if (!line) continue
    lines.push(line)
    broadcast("trace", line)
  }
}

function status(): string {
  return JSON.stringify(run ? { running: true, speed: run.speed, scene: run.scene } : { running: false })
}

function startRun(scene: Scene, speed: number): void {
  const script = scene === "demo" ? "src/run.ts" : "eval/critic.ts"
  const child = spawn("node_modules/.bin/tsx", [script, "--replay", `--paced=${speed}`, `--trace=${TRACES[1]}`], { stdio: ["ignore", "pipe", "pipe"] })
  run = { child, speed, scene }
  broadcast("status", status())
  const forward = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n").filter((l) => l && !l.startsWith("mozaik cloud"))) broadcast("log", JSON.stringify(line))
  }
  child.stdout?.on("data", forward)
  child.stderr?.on("data", forward)
  child.on("exit", (code) => {
    run = undefined
    broadcast("log", JSON.stringify(`run finished (exit ${code})`))
    broadcast("status", status())
  })
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`)
  const path = url.pathname

  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    return void res.end(readFileSync(PAGE, "utf8"))
  }

  if (path === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    send(res, "reset", "{}")
    for (const line of lines) send(res, "trace", line)
    send(res, "status", status())
    clients.add(res)
    return void req.on("close", () => clients.delete(res))
  }

  if ((path === "/run" || path === "/plant") && req.method === "POST") {
    if (run) return void res.writeHead(409).end("a run is in progress")
    // The planted claims run at recorded pace: one support-check call, a couple of seconds.
    const speed = path === "/plant" ? 1 : Math.min(Math.max(Number(url.searchParams.get("speed")) || 4, 1), 64)
    startRun(path === "/run" ? "demo" : "plant", speed)
    return void res.writeHead(202).end()
  }

  // Ids on the page link here: the cited record, straight from the dataset.
  const record = /^\/record\/([A-Za-z0-9-]+)$/.exec(path)
  if (record) {
    if (!hasDataset()) return void res.writeHead(404, { "content-type": "text/plain" }).end("dataset missing: run `npm run setup`")
    data ??= Dataset.load()
    const found = data.record(record[1])
    if (!found) return void res.writeHead(404, { "content-type": "text/plain" }).end(`no record ${record[1]}`)
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
    return void res.end(JSON.stringify(found, null, 2))
  }

  // The logo and app mark (media/), for the page header and the favicon.
  const media = /^\/media\/([A-Za-z0-9-]+)\.(svg|png)$/.exec(path)
  if (media && existsSync(`media/${media[1]}.${media[2]}`)) {
    res.writeHead(200, { "content-type": media[2] === "svg" ? "image/svg+xml" : "image/png", "cache-control": "max-age=3600" })
    return void res.end(readFileSync(`media/${media[1]}.${media[2]}`))
  }

  const proposal = /^\/proposal\/([A-Za-z0-9_-]+)$/.exec(path)
  if (proposal && existsSync(`out/proposals/${proposal[1]}.md`)) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
    return void res.end(readFileSync(`out/proposals/${proposal[1]}.md`, "utf8"))
  }

  res.writeHead(404, { "content-type": "text/plain" }).end("not found")
})

setInterval(poll, 150)
poll()
// Localhost only: the Run button starts a process, and the board is for the presenter's screen.
server.listen(PORT, "127.0.0.1", () => console.log(`board: http://localhost:${PORT} (follows the newest of ${TRACES.join(", ")}; Run replays the demo set at recorded latency)`))
