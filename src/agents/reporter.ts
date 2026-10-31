import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createHuman, type Human } from "@mozaik-ai/core"
import { on } from "../runtime"
import type { ProfileCard } from "../schema/profile"
import type { Dataset } from "../tools/dataset"
import { trapFlags, type TrapFlag, type TrapKind } from "../tools/profile"
import { PERSONAL, type Verdict } from "./critic"
import { exclusion, type NomatchVerdict } from "./matchmaker"

type Nomatch = { challengeId: string; verdict: NomatchVerdict; reason: string; nearest?: { researcherId: string; why?: string } }

const SUGGESTION: Record<NomatchVerdict, string> = {
  "not a research problem": "Not a question for a university researcher; handle it as a business or service request, and revisit if it becomes a technical problem.",
  "no good match": "Revisit when a researcher with publications on this topic joins the network.",
  "match exists but unavailable": "The researchers who fit can't take it on now (see why); revisit when their availability changes.",
  "no deal": "The terms couldn't be agreed; a mediator could reopen the sticking point named above.",
}

const TRAPS: { kind: TrapKind; label: string }[] = [
  { kind: "unavailable", label: "Unavailable (left, fully retired)" },
  { kind: "consulting_only", label: "Consulting only (retired, emeritus)" },
  { kind: "open_to_conflict", label: "open_to contradicts notes or bio (stricter source wins)" },
  { kind: "identity_conflict", label: "Notes about another person" },
  { kind: "same_name", label: "Same name, different people (joined on ids)" },
  { kind: "low_evidence", label: "Too little evidence (no bio or under 2 publications)" },
]

/** Collects no-matches, profile cards and Critic verdicts during a run; `write()` renders out/nomatch.md and out/traps.md. */
export function createReporter(data: Dataset): { participant: Human; write: (dir?: string) => void } {
  const nomatches: Nomatch[] = []
  const cards: ProfileCard[] = []
  const blocked: Verdict[] = []

  const participant = createHuman({
    name: "reporter",
    capabilities: ["report"],
    handlers: [
      { specification: on("prenup.nomatch"), processor: { apply: ({ event }) => void nomatches.push(event.payload as Nomatch) } },
      { specification: on("prenup.profile.ready"), processor: { apply: ({ event }) => void cards.push(event.payload as ProfileCard) } },
      {
        specification: on("prenup.critic.verdict"),
        processor: { apply: ({ event }) => void ((event.payload as Verdict).verdict !== "pass" && blocked.push(event.payload as Verdict)) },
      },
    ],
  })

  function write(dir = "out"): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "nomatch.md"), renderNomatch(nomatches, data))
    writeFileSync(join(dir, "traps.md"), renderTraps(data, cards, blocked))
  }

  return { participant, write }
}

function renderNomatch(nomatches: Nomatch[], data: Dataset): string {
  const entries = [...nomatches].sort((a, b) => a.challengeId.localeCompare(b.challengeId)).map((n) => {
    const text = data.challenges.get(n.challengeId)?.text ?? ""
    const nearest = n.nearest
      ? `[${n.nearest.researcherId}], the top search hit; not enough because ${n.nearest.why ?? "it was excluded"}`
      : "none: the challenge stopped before search"
    return [
      `## ${n.challengeId}: ${oneLine(text)}`,
      `**Verdict:** ${n.verdict}  `,
      `**Why:** ${n.reason} [${n.challengeId}]  `,
      `**Nearest candidate:** ${nearest}  `,
      `**Suggestion:** ${SUGGESTION[n.verdict]}`,
    ].join("\n")
  })
  return `# No match\n\nChallenges in this run that got no proposal, and why. Saying no is a result, not a failure.\n\n${entries.join("\n\n") || "Every challenge in this run got a proposal."}\n`
}

const CHECK_ORDER = ["exists", "quote", "ownership", "policy", "numbers", "support"]

function renderTraps(data: Dataset, cards: ProfileCard[], blocked: Verdict[]): string {
  const flagged = [...data.researchers.values()].map((r) => ({ r, flags: trapFlags(r, data) }))
  const cyrillic = [...data.researchers.values()].filter((r) => /[Ѐ-ӿ]/.test(`${r.name} ${r.bio} ${r.notes}`))
  const example = (id: string, f: TrapFlag) => `[${id}] ${f.detail}${f.source ? `: "${oneLine(f.source.quote, 90)}" [${f.source.id} ${f.source.field}]` : ""}`
  const dataset = TRAPS.map(({ kind, label }) => {
    const hits = flagged.flatMap(({ r, flags }) => flags.filter((f) => f.kind === kind).map((f) => ({ id: r.id, f })))
    return `| ${label} | ${hits.length} | ${hits.slice(0, 2).map((h) => example(h.id, h.f)).join("<br>") || "-"} |`
  })
  dataset.push(`| Profiles with Cyrillic text, transliterated before search and quote checks | ${cyrillic.length} | ${cyrillic.slice(0, 2).map((r) => `[${r.id}]`).join(", ")} |`)

  // Sorted by challenge, then researcher: cards arrive in timing order, and the report must not change between replays.
  const ordered = [...cards].sort((a, b) => a.challengeId.localeCompare(b.challengeId) || a.researcherId.localeCompare(b.researcherId))
  const skipped = ordered.filter((c) => exclusion(c)).map((c) => `- [${c.researcherId}] on [${c.challengeId}]: ${exclusion(c)}`)
  const flaggedInRun = ordered.filter((c) => c.flags.length > 0).map((c) => `- [${c.researcherId}] on [${c.challengeId}]: ${c.flags.map((f) => f.kind).join(", ")}`)
  // Sorted by check, then claim id: events arrive in timing order, and the report must not change between replays.
  const byCheck = new Map<string, Verdict[]>(CHECK_ORDER.map((check) => [check, []]))
  for (const v of [...blocked].sort((a, b) => a.claimId.localeCompare(b.claimId))) byCheck.set(v.check ?? "other", [...(byCheck.get(v.check ?? "other") ?? []), v])
  const blocks = [...byCheck].filter(([, vs]) => vs.length > 0).map(([check, vs]) => `- ${check}: ${vs.length} (e.g. ${vs.slice(0, 2).map((v) => `${v.claimId}: ${v.reason}`).join("; ")})`)

  return [
    "# Traps",
    "",
    "The dataset hides traps on purpose. These are caught by code, not by a model, and every example cites its record.",
    "",
    `## Across the dataset (all ${data.researchers.size} profiles)`,
    "",
    "| Trap | Profiles | Examples |",
    "|---|---|---|",
    ...dataset,
    "",
    "## In this run",
    "",
    `Shortlisted researchers the matchmakers skipped (${skipped.length}):`,
    "",
    ...(skipped.length ? skipped : ["- none"]),
    "",
    `Shortlisted researchers with trap flags (${flaggedInRun.length}):`,
    "",
    ...(flaggedInRun.length ? flaggedInRun : ["- none"]),
    "",
    `Times the Critic stopped a claim (${blocked.length}, rewrites included; stopped claims go back to their author once), by check:`,
    "",
    ...(blocks.length ? blocks : ["- none"]),
    "",
  ].join("\n")
}

export function oneLine(text: string, max = 140): string {
  const line = text.replace(/\s+/g, " ").trim()
  if (PERSONAL.test(line)) return "(not shown: the challenge's text mentions someone's personal situation)"
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
