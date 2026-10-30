// npm run eval:batch: what a run beyond the demo set did, from its trace (default out/batch/trace.jsonl): outcomes per
// challenge, how often it said no and why, conflicts, the Critic's work and the model calls. Writes out/batch/summary.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const tracePath = process.argv[2] ?? "out/batch/trace.jsonl"
type Line = { t: string; type: string; producer: string; payload: Record<string, unknown> | string }
const lines = readFileSync(tracePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line)
const events = (type: string) => lines.filter((l) => l.type === type && typeof l.payload === "object").map((l) => l.payload as Record<string, unknown>)

const submitted = events("prenup.challenge.submitted").map((p) => p.challengeId as string)
const proposals = events("prenup.proposal.ready")
const nomatches = events("prenup.nomatch")
const verdicts = events("prenup.critic.verdict")
const firstPass = verdicts.filter((v) => v.attempt === 1)
const loops = lines.filter((l) => l.type === "inference.started").length

const outcome = (id: string) => {
  const proposal = proposals.find((p) => String(p.pairId).startsWith(`${id}__`))
  if (proposal) return { challengeId: id, outcome: "proposal", pair: proposal.pairId, claims: proposal.claims, stopped: proposal.stopped, dropped: proposal.dropped }
  const no = nomatches.find((n) => n.challengeId === id)
  return { challengeId: id, outcome: "no match", verdict: no?.verdict, reason: no?.reason }
}
const byVerdict: Record<string, number> = {}
for (const n of nomatches) byVerdict[String(n.verdict)] = (byVerdict[String(n.verdict)] ?? 0) + 1

const summary = {
  trace: tracePath,
  challenges: submitted.length,
  proposals: proposals.length,
  noMatch: nomatches.length,
  noMatchByVerdict: byVerdict,
  conflicts: events("prenup.reservation.conflict").length,
  arbiterDecisions: events("prenup.arbiter.decided").length,
  negotiationsWithoutDeal: events("prenup.negotiation.no_deal").length,
  critic: {
    claimsChecked: firstPass.length,
    stoppedFirstPass: firstPass.filter((v) => v.verdict !== "pass").length,
    dropped: events("prenup.claim.dropped").length,
  },
  modelCalls: loops, // no wall-clock: a run that reuses recorded answers isn't timed fairly; see out/eval/concurrency.json
  perChallenge: submitted.sort().map(outcome),
}
mkdirSync(dirname(tracePath), { recursive: true })
writeFileSync(`${dirname(tracePath)}/summary.json`, JSON.stringify(summary, null, 2) + "\n")
console.log(JSON.stringify({ ...summary, perChallenge: undefined }, null, 2))
for (const c of summary.perChallenge) console.log(`${c.challengeId}: ${c.outcome}${c.outcome === "proposal" ? ` ${c.pair}` : ` (${c.verdict})`}`)
