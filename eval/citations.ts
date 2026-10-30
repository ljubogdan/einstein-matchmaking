// npm run eval:citations: reports on the citations in negotiation moves. During a run, code keeps a citation only if its
// quote is on that line of the position card (checkCitations). Here, code checks each one points to a real record. REVIEW
// is a reading of whether the quote backs the statement it's attached to, done by Claude, not by a person. Stances and contract terms need no
// source. A citation the review doesn't cover shows as "unreviewed". Report only: nothing here changes a run. No model
// calls. Reads the 1x trace. Writes out/eval/citations.json.
import { readFileSync, writeFileSync } from "node:fs"
import { Dataset } from "../src/tools/dataset"

const TRACE = "out/eval/trace-replay-1x.jsonl"
const REVIEW: Record<string, "yes" | "partly" | "no"> = {
  "C001-CH1__R1015/1/company/C001 rd_capacity": "yes",
  "C001-CH1__R1015/1/company/C001 past_collaborations": "yes",
  "C061-CH1__R0231/1/company/SYN-PUB-02918": "yes",
  "C061-CH1__R0231/1/company/SYN-PUB-02921": "yes",
  "C061-CH1__R0231/2/researcher/R0231 publications": "yes",
  "C032-CH1__R1015/1/company/C032 products": "yes",
  "C032-CH1__R1015/1/company/C032-CH1": "no", // attack simulations, used for protecting customer data
  "C001-CH1__R1008/1/company/SYN-PUB-10477": "yes",
  "C001-CH1__R1008/1/company/SYN-PUB-10472": "yes",
  "C001-CH1__R1008/1/company/C001 past_collaborations": "yes",
  "C032-CH1__R1015/2/researcher/R1015 projects": "yes",
  "C001-CH1__R1008/2/researcher/R1008 open_to": "yes",
  "C061-CH1__R0231/3/company/C061 plans": "yes",
  "C001-CH1__R1008/3/company/C001 plans": "yes",
  "C001-CH1__R1008/3/company/C001 rd_capacity": "yes",
  "C032-CH1__R1015/3/company/C032 products": "yes",
  "C032-CH1__R1015/3/company/C032-CH1": "yes",
  "C061-CH1__R0231/4/researcher/R0231 publications": "partly", // shows a record, not that a review protects rights
  "C001-CH1__R1008/4/researcher/R1008 open_to": "no", // engagement types, used for background IP
  "C032-CH1__R1015/4/researcher/R1015 projects": "partly", // the project exists; its protection isn't stated
}

const data = Dataset.load()
const moves = readFileSync(TRACE, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; payload: Record<string, any> }).filter((l) => l.type === "prenup.negotiation.move")
const seen = new Map<string, number>()
const rows = moves.flatMap(({ payload }) =>
  [...String(payload.reason).matchAll(/\[([^\]]+)\]/g)]
    .flatMap((m) => m[1].split(/,\s*/))
    .map((ref) => {
      const [id, field] = ref.trim().split(/\s+/)
      const quote = (payload.evidence as { citation: string; quote: string }[] | undefined)?.find((e) => e.citation === ref.trim())?.quote
      const record = data.record(id) as Record<string, unknown> | undefined
      const base = `${payload.pairId}/${payload.round}/${payload.side}/${ref.trim()}`
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      return { citation: n > 1 ? `${base}#${n}` : base, resolves: !!record && (!field || field in record), quote, reason: payload.reason as string, review: REVIEW[n > 1 ? `${base}#${n}` : base] ?? "unreviewed" }
    }),
)
const count = (key: "review") => rows.reduce<Record<string, number>>((all, r) => ({ ...all, [r[key]]: (all[r[key]] ?? 0) + 1 }), {})
const result = {
  what: "Citations in the recorded negotiation moves, with the exact words behind each. resolves: checked by code. review: whether the quote backs the statement the citation is attached to, read by Claude, not by a person.",
  trace: TRACE,
  citations: rows.length,
  resolve: rows.filter((r) => r.resolves).length,
  review: count("review"),
  rows,
}
writeFileSync("out/eval/citations.json", JSON.stringify(result, null, 2) + "\n")
console.log(`${result.citations} citations, ${result.resolve} resolve; review: ${JSON.stringify(result.review)}`)
