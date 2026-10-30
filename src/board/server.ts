// npm run board: the live board at http://localhost:4173. It follows out/trace.jsonl as any run writes it and sends
// each line to the page (Server-Sent Events). "Run" starts `src/run.ts --replay --paced=N`: the agents run again on the
// recorded answers, each answer arriving after its recorded latency divided by N. No key, no network.
import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { Dataset, hasDataset } from "../tools/dataset"

const PORT = Number(process.env.PORT ?? 4173)
const TRACE = "out/trace.jsonl"
const PAGE = "src/board/index.html"
const HEAD_BYTES = 64 // the first line starts with its timestamp: a changed head means a new run rewrote the file

// The current run's trace, as complete lines. A new run truncates the file; followers then get "reset".
let lines: string[] = []
let offset = 0
let head = ""
let rest = Buffer.alloc(0)
const clients = new Set<ServerResponse>()
let run: { child: ChildProcess; speed: number } | undefined
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

function poll(): void {
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
  return JSON.stringify(run ? { running: true, speed: run.speed } : { running: false })
}

function startRun(speed: number): void {
  const child = spawn("node_modules/.bin/tsx", ["src/run.ts", "--replay", `--paced=${speed}`], { stdio: ["ignore", "pipe", "pipe"] })
  run = { child, speed }
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

  if (path === "/run" && req.method === "POST") {
    if (run) return void res.writeHead(409).end("a run is in progress")
    const speed = Math.min(Math.max(Number(url.searchParams.get("speed")) || 4, 1), 64)
    startRun(speed)
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
server.listen(PORT, "127.0.0.1", () => console.log(`board: http://localhost:${PORT} (following ${TRACE}; Run replays the demo set at recorded latency)`))
