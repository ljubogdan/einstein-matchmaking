import { createHuman, SemanticEvent, type Human } from "@mozaik-ai/core"
import { sendEvent, on } from "../runtime"
import type { Claim, Source } from "../schema/claim"
import type { NegotiationMove } from "../schema/termsheet"
import { fieldText, type Dataset } from "../tools/dataset"
import { normalize } from "../tools/normalize"
import { allowedEngagements, availabilityOf } from "../tools/profile"

export type CheckName = "exists" | "quote" | "ownership" | "policy" | "numbers"
export type Verdict = { claimId: string; subject: string; verdict: "pass" | "block"; check?: CheckName; reason?: string }
export type CriticContext = { data: Dataset; move: (pairId: string, round: number) => NegotiationMove | undefined }

const IDS = /\b(?:SYN-(?:PUB|PRJ|PAT)-\d+|C\d{3}-CH\d+|C\d{3}|R\d{4})\b/g
const WORTH = /\b(?:best|leading|world-class|renowned|outstanding|brilliant|eminent|top (?:researcher|scientist|expert)s?|most (?:talented|qualified|respected))\b/i
const PERSONAL = /\b(?:\d+ years old|gender|married|religio\w*|nationality|ethnic\w*)\b/i

/** The deterministic checks, cheapest first. The first failure blocks the claim. No LLM. */
export function checkClaim(claim: Claim, ctx: CriticContext): Verdict {
  const block = (check: CheckName, reason: string): Verdict => ({ claimId: claim.id, subject: claim.subject, verdict: "block", check, reason })

  // 1. Every source exists.
  if (claim.sources.length === 0) return block("exists", "no source")
  for (const s of claim.sources) if (!sourceRecord(s, ctx)) return block("exists", `${s.id} not found`)

  // 2. Every quote is in its source field.
  for (const s of claim.sources) {
    const text = sourceText(s, ctx)
    if (text === undefined) return block("quote", `${s.id} has no field "${s.field}"`)
    if (!s.quote.trim() || !normalize(text).includes(normalize(s.quote))) return block("quote", `quote not found in ${s.id}.${s.field}`)
  }

  // 3. Every source belongs to the subject (ids, never names: catches the same-name trap).
  for (const s of claim.sources) if (!belongsTo(s.id, claim.subject, ctx)) return block("ownership", `${s.id} does not belong to ${claim.subject}`)

  // 4. Policy: no worth language or personal attributes; terms stay inside open_to and availability.
  if (WORTH.test(claim.text)) return block("policy", "ranks or praises a person")
  if (PERSONAL.test(claim.text)) return block("policy", "mentions a personal attribute")
  const researcher = ctx.data.researchers.get(claim.subject.split("__").at(-1) ?? "")
  if (claim.kind === "term" && researcher) {
    const allowed = allowedEngagements(researcher)
    if (allowed.length === 0) return block("policy", `${researcher.id} is not available: "${availabilityOf(researcher).evidence?.quote ?? "nothing in open_to"}"`)
    const engagement = claim.sources.find((s) => s.field === "sheet.engagement")?.quote
    if (engagement && !allowed.includes(engagement as never)) return block("policy", `${engagement} is not allowed for ${researcher.id} (allowed: ${allowed.join(", ")})`)
  }
  const money = claim.sources.find((s) => s.field === "sheet.money")?.quote
  if (claim.kind === "term" && money && /\d|€|\$|\beur\b|\brsd\b|\bdinar/i.test(money)) return block("policy", "money must be 'to be agreed' or a funding route, never an amount")

  // 5. Every number in the sentence is in a quote (ids don't count).
  const quoted = normalize(claim.sources.map((s) => s.quote).join(" "))
  for (const n of claim.text.replace(IDS, "").match(/\d+(?:[.,]\d+)*/g) ?? []) {
    if (!quoted.includes(n)) return block("numbers", `${n} is not in any quoted source`)
  }

  return { claimId: claim.id, subject: claim.subject, verdict: "pass" }
}

// Term sources point at a recorded move: "move:<pairId>:<round>", field "sheet.<path>".
function parseMove(id: string): [string, number] | undefined {
  const m = /^move:(.+):(\d+)$/.exec(id)
  return m ? [m[1], Number(m[2])] : undefined
}

function sourceRecord(s: Source, ctx: CriticContext): Record<string, unknown> | undefined {
  const move = parseMove(s.id)
  return move ? (ctx.move(...move) as Record<string, unknown> | undefined) : ctx.data.record(s.id)
}

function sourceText(s: Source, ctx: CriticContext): string | undefined {
  const record = sourceRecord(s, ctx)
  if (!record) return undefined
  if (!parseMove(s.id)) return fieldText(record, s.field)
  const value = s.field.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], record)
  return value === undefined ? undefined : typeof value === "string" ? value : JSON.stringify(value)
}

function belongsTo(id: string, subject: string, ctx: CriticContext): boolean {
  const move = parseMove(id)
  if (move) return move[0] === subject || move[0].split("__").includes(subject)
  const [challengeId, researcherId] = subject.split("__")
  if (researcherId) return belongsTo(id, challengeId, ctx) || belongsTo(id, researcherId, ctx)
  if (id === subject) return true
  const { data } = ctx
  if (data.researchers.has(subject)) {
    const publication = data.publications.get(id)
    if (publication) return publication.authors.some((a) => a.researcher_id === subject)
    const project = data.projects.get(id)
    if (project) return project.participants.some((p) => p.researcher_id === subject)
    return data.researchers.get(subject)?.patents.includes(id) ?? false
  }
  if (data.companies.has(subject)) return data.challengeCompany.get(id) === subject
  if (data.challenges.has(subject)) return data.challengeCompany.get(subject) === id
  return false
}

/** Checks every claim in `prenup.critic.check`; one `prenup.critic.verdict` per claim, then `prenup.critic.done`. */
export function createCritic(ctx: CriticContext): Human {
  return createHuman({
    name: "critic",
    capabilities: ["check-claims"],
    handlers: [
      {
        specification: on("prenup.critic.check"),
        processor: {
          apply: ({ event, participant }) => {
            const { pairId, claims } = event.payload as { pairId: string; claims: Claim[] }
            const verdicts = claims.map((claim) => checkClaim(claim, ctx))
            const emit = (type: string, payload: unknown) => sendEvent(SemanticEvent.create(type, participant.getId(), payload), participant.getId())
            for (const verdict of verdicts) emit("prenup.critic.verdict", { pairId, ...verdict })
            emit("prenup.critic.done", { pairId, verdicts })
          },
        },
      },
    ],
  })
}
