import type { Verdict } from "../agents/critic"
import type { Claim, Draft } from "../schema/claim"
import type { NegotiationMove } from "../schema/termsheet"
import type { Pair } from "../tools/cards"
import { ENGAGEMENT_LABELS } from "./terms"

type Input = { pair: Pair; draft: Draft; claims: Claim[]; verdicts: Verdict[]; moves: NegotiationMove[]; agreed: NegotiationMove }

/** One page per pair (prenup-proposal). Only claims the Critic passed are printed; header facts come straight from the data. */
export function renderProposal({ pair, draft, claims, verdicts, moves, agreed }: Input): string {
  const { company: c, researcher: r, challenge: ch } = pair
  const passed = new Set(verdicts.filter((v) => v.verdict === "pass").map((v) => v.claimId))
  const blocked = verdicts.filter((v) => v.verdict === "block")
  const section = (name: string) => claims.filter((cl) => cl.id.includes(`/${name}/`) && passed.has(cl.id))
  const cite = (cl: Claim) => {
    const ids = [...new Set(cl.sources.map((s) => (s.id.startsWith("move:") ? `term sheet, round ${agreed.round}` : s.id)))]
    return `${cl.text} ${ids.map((id) => `[${id}]`).join(" ")}`
  }
  const bullets = (name: string) => section(name).map((cl) => `- ${cite(cl)}`).join("\n") || "- (no claim passed the Critic)"
  const term = (key: string) => (passed.has(`${pair.pairId}/terms/${key}`) ? claims.find((cl) => cl.id === `${pair.pairId}/terms/${key}`) : undefined)
  const engagement = term("engagement") ? ENGAGEMENT_LABELS[agreed.sheet.engagement] : "not agreed (blocked by the Critic)"
  const isProject = agreed.sheet.engagement !== "industrial_phd"

  return [
    `# ${draft.title}`,
    "",
    `**Company:** ${c.name} [${c.id}], ${c.sector}, ${c.employees} employees, ${c.location}.  `,
    `**Faculty:** ${r.faculty}, ${r.department} [${r.id}].  `,
    `**Format:** ${engagement}  `,
    `**Supervisors / contacts:** ${agreed.sheet.contact.university} (academic) and ${agreed.sheet.contact.company} (company)`,
    "",
    "### The problem",
    bullets("problem"),
    "",
    isProject ? "### Work packages" : "### Research questions",
    ...draft.researchQuestions.map((q, i) => `${i + 1}. ${q}`),
    "",
    "### Plan",
    "| Phase | Work | Result |",
    "|---|---|---|",
    ...draft.plan.map((p) => `| ${p.phase} | ${p.work} | ${p.result} |`),
    "",
    "### What each side brings",
    `**Company** [${c.id}]`,
    bullets("companyBrings"),
    `**University** [${r.id}]`,
    bullets("universityBrings"),
    "",
    "### Why this pair",
    bullets("whyThisPair"),
    "",
    "### Agreed up front",
    bullets("terms"),
    "",
    "<details><summary>How we got here</summary>",
    "",
    `Negotiation on challenge ${ch.id}, ${moves.length} moves:`,
    ...moves.map((m) => `- Round ${m.round}, ${m.side}: ${m.action}${m.changes.length ? ` (changed ${m.changes.join(", ")})` : ""}. ${m.reason}`),
    "",
    `Checked: ${verdicts.length} claims, ${blocked.length} blocked by the Critic${blocked.length ? ":" : "."}`,
    ...blocked.map((v) => `- ${v.claimId.split("/").slice(1).join("/")}: ${v.check}, ${v.reason}`),
    "",
    `Trace: out/trace.jsonl, pair ${pair.pairId}.`,
    "</details>",
    "",
  ].join("\n")
}
