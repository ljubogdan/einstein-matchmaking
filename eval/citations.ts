// npm run eval:citations: checks what the Critic doesn't check during a run, the field citations in negotiation moves.
// Code checks that each one points to a real field of a real record. REVIEW below is a reading of whether the field
// backs the statement the citation is attached to, done by Claude, not by a person. Stances and contract terms need no
// source. A citation the review doesn't cover shows as "unreviewed". Report only: nothing here changes a run. No model
// calls. Reads the 1x trace. Writes out/eval/citations.json.
import { readFileSync, writeFileSync } from "node:fs"
import { Dataset } from "../src/tools/dataset"

const TRACE = "out/eval/trace-replay-1x.jsonl"
const REVIEW: Record<string, "yes" | "partly" | "no"> = {
  "C001-CH1__R1015/1/company/C001 plans": "partly", // the fifth hardware variant is there, ProtoSense isn't
  "C001-CH1__R1015/1/company/C001 rd_capacity": "partly", // access under NDA, not a review window
  "C061-CH1__R0231/1/company/C061 past_collaborations": "yes",
  "C061-CH1__R0231/1/company/C061 rd_capacity": "no", // lab capacity, used for protecting production data
  "C061-CH1__R0231/2/researcher/R0231 publications": "yes", // the 16 publications
  "C061-CH1__R0231/2/researcher/R0231 publications#2": "partly", // used again for not blocking dissemination
  "C001-CH1__R1008/1/company/C001 plans": "partly", // the late-2025 release is there, a ProtoSense roadmap isn't
  "C001-CH1__R1008/1/company/C001 past_collaborations": "yes",
  "C032-CH1__R1015/1/company/C032 products": "yes",
  "C032-CH1__R1015/1/company/C032 plans": "yes",
  "C032-CH1__R1015/1/company/C032 past_collaborations": "yes", // "None."
  "C061-CH1__R0231/3/company/C061 past_collaborations": "yes",
  "C001-CH1__R1008/2/researcher/R1008 publications": "partly", // shows a record, not a right to publish
  "C032-CH1__R1015/2/researcher/R1015 publications": "partly",
  "C001-CH1__R1008/3/company/C001 plans": "yes",
  "C001-CH1__R1008/4/researcher/R1008 publications": "partly",
  "C001-CH1__R1008/4/researcher/R1008 notes": "yes",
  "C032-CH1__R1015/3/company/C032 products": "yes",
  "C032-CH1__R1015/4/researcher/R1015 publications": "partly",
  "C032-CH1__R1015/4/researcher/R1015 projects": "partly", // the project exists; its protection isn't stated
}

const data = Dataset.load()
const moves = readFileSync(TRACE, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; payload: Record<string, any> }).filter((l) => l.type === "prenup.negotiation.move")
const seen = new Map<string, number>()
const rows = moves.flatMap(({ payload }) =>
  [...String(payload.reason).matchAll(/\[([^\]]+)\]/g)]
    .flatMap((m) => m[1].split(/,\s*/))
    .filter((ref) => /\s/.test(ref.trim())) // id + field; a bare id only names something
    .map((ref) => {
      const [id, field] = ref.trim().split(/\s+/)
      const record = data.record(id) as Record<string, unknown> | undefined
      const base = `${payload.pairId}/${payload.round}/${payload.side}/${ref.trim()}`
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      return { citation: n > 1 ? `${base}#${n}` : base, resolves: !!record && field in record, reason: payload.reason as string, review: REVIEW[n > 1 ? `${base}#${n}` : base] ?? "unreviewed" }
    }),
)
const count = (key: "review") => rows.reduce<Record<string, number>>((all, r) => ({ ...all, [r[key]]: (all[r[key]] ?? 0) + 1 }), {})
const result = {
  what: "Field citations in the recorded negotiation moves. resolves: checked by code. review: whether the field backs the statement the citation is attached to, read by Claude, not by a person. The Critic doesn't check these during a run.",
  trace: TRACE,
  citations: rows.length,
  resolve: rows.filter((r) => r.resolves).length,
  review: count("review"),
  rows,
}
writeFileSync("out/eval/citations.json", JSON.stringify(result, null, 2) + "\n")
console.log(`${result.citations} citations, ${result.resolve} resolve; review: ${JSON.stringify(result.review)}`)
