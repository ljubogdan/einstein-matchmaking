// npm run eval:critic [-- --replay] [-- --no-support] [-- --paced] [-- --trace=PATH]: plants 20 false claims of 7 kinds, built by code from real records, and sends them
// to the Critic as one check request, the way the writer does (deterministic checks, then one cheap-model support check).
// Reports which check caught each and which got through. Writes out/eval/critic.json. The faults go to the Critic
// directly, not through the writer, so this measures the Critic, not whether a writer would make these mistakes.
// With --trace (the board's "Plant false claims"), it writes a trace for the board instead of out/eval/.
import "../src/env"
import { mkdirSync, writeFileSync } from "node:fs"
import { createHuman, SemanticEvent } from "@mozaik-ai/core"
import { createCritic, type Verdict } from "../src/agents/critic"
import { createTraceObserver } from "../src/agents/observer"
import { RecordingRunner } from "../src/llm/runner"
import { MODELS } from "../src/models"
import { Board, initializeRuntime, join, on, sendEvent } from "../src/runtime"
import type { Claim } from "../src/schema/claim"
import type { NegotiationMove, TermSheet } from "../src/schema/termsheet"
import { Dataset, type Publication } from "../src/tools/dataset"

type Kind = "fake id" | "altered quote" | "same-name swap" | "engagement not in open_to" | "invented money" | "unavailable person" | "says more than its quote"
type Fault = { kind: Kind; claim: Claim; planted: string }

const data = Dataset.load()
const mode = process.argv.includes("--replay") ? "replay" : "record"
const support = !process.argv.includes("--no-support") // ablation: the deterministic checks alone
const flag = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}`))?.split("=")[1]
const trace = flag("trace")
const pace = process.argv.some((arg) => arg.startsWith("--paced")) ? Number(flag("paced") ?? 1) || 1 : undefined
const words = (text: string, from: number, n: number) => text.split(/\s+/).slice(from, from + n).join(" ")
const authored = (rid: string): Publication[] =>
  data.researchers.get(rid)!.publications.map((id) => data.publications.get(id)!).filter((p) => p?.authors.some((a) => a.researcher_id === rid))
const firstPub = (rid: string) => authored(rid)[0]

// Term claims cite a recorded move, as the writer's do; these sheets exist only in this eval.
const moves = new Map<string, NegotiationMove>()
function term(n: number, researcherId: string, field: "engagement" | "money", value: string, text: string): Claim {
  const pairId = `eval-${n}__${researcherId}` // one sheet per fault
  const sheet = { engagement: "joint_project", money: "to be agreed", [field]: value } as unknown as TermSheet
  moves.set(pairId, { pairId, side: "company", round: 1, action: "propose", sheet, reason: "", citations: [], changes: [] })
  return { id: `fault/${n}`, subject: researcherId, kind: "term", text, sources: [{ id: `move:${pairId}:1`, field: `sheet.${field}`, quote: value }] }
}
const fact = (n: number, subject: string, text: string, id: string, field: string, quote: string): Claim => ({ id: `fault/${n}`, subject, kind: "fact", text, sources: [{ id, field, quote }] })

const p10523 = data.publications.get("SYN-PUB-10523")!
const p10525 = data.publications.get("SYN-PUB-10525")!
const c001 = data.companies.get("C001")!
const ch = data.challenges.get("C001-CH1")!
const swap = (text: string, at: number, word: string) => text.split(" ").map((w, i) => (i === at ? word : w)).join(" ")

const faults: Fault[] = [
  { kind: "fake id", planted: "publication id that doesn't exist", claim: fact(1, "R1015", "R1015 has published on BACnet fuzzing.", "SYN-PUB-99999", "abstract", "a fuzzing framework for BACnet devices") },
  { kind: "fake id", planted: "project id that doesn't exist", claim: fact(2, "R1015", "R1015 led a national project on substation security.", "SYN-PRJ-9999", "summary", "security monitoring for electrical substations") },
  { kind: "fake id", planted: "company id that doesn't exist", claim: fact(3, "C001", "ArmaturaSec has a sister company that funds research.", "C999", "about", "funds applied research in industrial security") },
  { kind: "altered quote", planted: "one word changed in a real abstract window", claim: fact(4, "R1015", "Their study compares intrusion detection architectures.", p10525.id, "abstract", swap(words(p10525.abstract, 0, 12), 3, "Industrial")) },
  { kind: "altered quote", planted: "one word changed in a real abstract window", claim: fact(5, "R1015", "Their work detects anomalies in Modbus traffic.", p10523.id, "abstract", swap(words(p10523.abstract, 0, 12), 5, "proprietary")) },
  { kind: "altered quote", planted: "one word changed in the company's R&D capacity", claim: fact(6, "C001", "ArmaturaSec can dedicate engineers full-time.", "C001", "rd_capacity", c001.rd_capacity.replace("part-time", "full-time").split(/\s+/).slice(0, 14).join(" ")) },
  { kind: "altered quote", planted: "a real quote attributed to the wrong field", claim: fact(7, "R1015", "Their paper compares five architectures.", p10525.id, "title", words(p10525.abstract, 60, 10)) },
  ...[["R0881", "R0128"], ["R0435", "R0191"], ["R0894", "R0929"]].map(([subject, namesake], i): Fault => {
    const p = firstPub(namesake)
    return { kind: "same-name swap", planted: `${namesake}'s paper credited to ${subject}, who has the same name`, claim: fact(8 + i, subject, `${subject} published "${p.title}".`, p.id, "title", p.title) }
  }),
  { kind: "engagement not in open_to", planted: "contract research for R1015 (open to joint projects, industrial PhD)", claim: term(11, "R1015", "engagement", "contract_research", "Format: Contract research") },
  { kind: "engagement not in open_to", planted: "industrial PhD for R0001 (not in open_to)", claim: term(12, "R0001", "engagement", "industrial_phd", "Format: Industrial PhD") },
  { kind: "invented money", planted: "a euro figure in a fact, quoting a sentence without it", claim: fact(13, "C001", "ArmaturaSec will fund the project with €50,000.", "C001", "rd_capacity", words(c001.rd_capacity, 0, 12)) },
  { kind: "invented money", planted: "an amount in the agreed money term", claim: term(14, "R1015", "money", "€30,000 from the company", "Money: €30,000 from the company.") },
  { kind: "unavailable person", planted: "consulting for R0881 (open_to says consulting; notes say fully retired)", claim: term(15, "R0881", "engagement", "consulting", "Format: Consulting") },
  { kind: "unavailable person", planted: "a joint project for R0068 (left the university)", claim: term(16, "R0068", "engagement", "joint_project", "Format: Joint project") },
  { kind: "says more than its quote", planted: "real verbatim quote, sentence adds a deployment", claim: fact(17, "R1015", "R1015's autoencoder detector has been deployed at several utilities.", p10523.id, "abstract", words(p10523.abstract, 0, 14)) },
  { kind: "says more than its quote", planted: "real verbatim quote, sentence turns part-time into full-time", claim: fact(18, "C001", "ArmaturaSec will put two engineers on the project full-time for its whole duration.", "C001", "rd_capacity", words(c001.rd_capacity, 0, 12)) },
  { kind: "says more than its quote", planted: "real verbatim quote, sentence adds lost clients", claim: fact(19, "C001-CH1", "ArmaturaSec has already lost clients because its detector missed attacks.", "C001-CH1", "text", words(ch.text, 0, 14)) },
  { kind: "says more than its quote", planted: "real verbatim quote, sentence claims the hybrid approach was proven in the field", claim: fact(20, "R1015", "R1015 proved in field trials that hybrid detectors outperform every other approach.", p10525.id, "abstract", words(p10525.abstract, 0, 14)) },
]

const runner = new RecordingRunner({ mode, pace })
initializeRuntime({ state: new Board(), inferenceRunnerConfig: { runner } })
if (trace) join(createTraceObserver(trace))
join(createCritic({ data, move: (pairId, round) => (round === 1 ? moves.get(pairId) : undefined) }, { support }))
const reader = createHuman({
  name: "eval",
  capabilities: ["eval"],
  handlers: [{ specification: on("prenup.critic.done"), processor: { apply: ({ event }) => report((event.payload as { verdicts: Verdict[] }).verdicts) } }],
})
join(reader)
process.on("unhandledRejection", (error) => {
  console.error(`model call failed: ${error}`)
  process.exit(1)
})

function report(verdicts: Verdict[]): void {
  const rows = faults.map((f) => {
    const v = verdicts.find((x) => x.claimId === f.claim.id)!
    return { kind: f.kind, planted: f.planted, claim: f.claim.text, caught: v.verdict !== "pass", verdict: v.verdict, check: v.check ?? null, reason: v.reason ?? null }
  })
  const kinds = [...new Set(faults.map((f) => f.kind))]
  const byKind = kinds.map((kind) => ({ kind, planted: rows.filter((r) => r.kind === kind).length, caught: rows.filter((r) => r.kind === kind && r.caught).length }))
  const byCheck = Object.fromEntries([...new Set(rows.map((r) => r.check ?? "missed"))].map((c) => [c, rows.filter((r) => (r.check ?? "missed") === c).length]))
  const result = {
    what: `20 planted false claims sent to the Critic as one check request (${support ? "deterministic checks, then the support check" : "deterministic checks only"})`,
    date: new Date().toISOString().slice(0, 10),
    supportModel: MODELS.cheap,
    planted: rows.length,
    caught: rows.filter((r) => r.caught).length,
    byKind,
    byCheck,
    faults: rows,
  }
  const out = trace ?? (support ? "out/eval/critic.json" : "out/eval/critic-no-support.json")
  if (!trace) {
    mkdirSync("out/eval", { recursive: true })
    writeFileSync(out, JSON.stringify(result, null, 2) + "\n")
  }
  console.log(`caught ${result.caught}/${result.planted} planted false claims`)
  for (const k of byKind) console.log(`  ${k.kind}: ${k.caught}/${k.planted}`)
  for (const r of rows.filter((r) => !r.caught)) console.log(`  MISSED (${r.kind}): ${r.claim}`)
  console.log(`by check: ${JSON.stringify(byCheck)}`)
  for (const line of runner.summary()) console.log(line)
  console.log(`written: ${out}`)
  process.exit(0)
}

// What was planted and why, for the board's labels; then the claims go to the Critic like a writer's draft.
sendEvent(SemanticEvent.create("prenup.eval.planted", reader.getId(), { pairId: "eval:faults", faults: faults.map((f) => ({ claimId: f.claim.id, kind: f.kind, planted: f.planted })) }), reader.getId())
sendEvent(SemanticEvent.create("prenup.critic.check", reader.getId(), { pairId: "eval:faults", claims: faults.map((f) => f.claim) }), reader.getId())
