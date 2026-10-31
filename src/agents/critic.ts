import { createAgent, createHuman, SemanticEvent, type Human } from "@mozaik-ai/core"
import { answerText, parseJson } from "../llm/answer"
import { MAX_OUTPUT, MODELS } from "../models"
import { join, on, own, runLoop, sendEvent } from "../runtime"
import { SupportAnswer, type Claim, type ClaimRewrites, type Source } from "../schema/claim"
import { structuredOutput } from "../schema/model-schema"
import type { NegotiationMove } from "../schema/termsheet"
import { fieldText, type Dataset } from "../tools/dataset"
import { normalize } from "../tools/normalize"
import { allowedEngagements, availabilityOf } from "../tools/profile"

export type CheckName = "exists" | "quote" | "ownership" | "policy" | "numbers" | "support"
// rewrite = the support check found the sentence says more than its quotes; it goes back to its author once.
export type Verdict = { claimId: string; subject: string; verdict: "pass" | "block" | "rewrite"; check?: CheckName; reason?: string; suggestion?: string }
export type CriticContext = { data: Dataset; move: (pairId: string, round: number) => NegotiationMove | undefined }

const IDS = /\b(?:SYN-(?:PUB|PRJ|PAT)-\d+|C\d{3}-CH\d+|C\d{3}|R\d{4})\b/g
// "leading" only as praise ("a leading expert"), not as a role in the work ("leading pipeline design").
const WORTH = /\b(?:best|leading (?:\w+ )?(?:expert|researcher|scientist|authority|specialist|professor|group|lab\w*)s?|world-class|renowned|outstanding|brilliant|eminent|top (?:researcher|scientist|expert)s?|most (?:talented|qualified|respected))\b/i
export const PERSONAL = /\b(?:\d+ years old|gender|married|religio\w*|nationality|ethnic\w*|maternity|paternity|pregnan\w*|sick leave)\b/i

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

  // 5. Every number in the sentence is in a cited field (ids don't count).
  const cited = normalize(claim.sources.map((s) => sourceText(s, ctx) ?? "").join(" "))
  for (const n of claim.text.replace(IDS, "").match(/\d+(?:[.,]\d+)*/g) ?? []) {
    if (!cited.includes(n)) return block("numbers", `${n} is not in any cited field`)
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

const MAX_FIELD = 3000 // long enough for any abstract or company text; a cap so one field can't crowd out the claims

const SUPPORT_INSTRUCTION = `You check whether sources support sentences. Each sentence comes with what it quotes and the whole field each quote is from. Read only those, not your own knowledge: a fact anywhere in a given field counts, facts from the sentence's different fields may be combined, and a quote that is too short is not a fault. For each numbered claim answer:
- support: "yes" if every fact the sentence states is in its fields. Plain paraphrase is fine, and so are rounding ("under a millisecond" for 0.9 ms), saying what a method can do when a field shows it doing that, and naming in general words what a field names in detail. "partly" only if you can name a specific fact in the sentence that none of its fields gives: an extra number, name, place, capability, result, purpose or comparison, or a word that overstates (all, always, proven, deployed, already). "no" if the fields don't back the sentence at all.
- A claim of kind inference draws a conclusion, for example why neither side could do the work alone; judge only whether the facts it rests on are in its fields, not the conclusion itself.
- reason: one short line naming the fact that is not supported; "" for yes.
- rewrite: for "partly", the sentence without that fact; otherwise "".`

/** The support check's input: numbered claims with their quotes and the whole fields they're from. */
export function supportMessage(claims: Claim[], ctx: CriticContext): string {
  const source = (s: Source) => [`  ${s.id} ${s.field}: "${s.quote}"`, `    Whole field: ${(sourceText(s, ctx) ?? "").slice(0, MAX_FIELD)}`]
  return claims.map((c, i) => [`Claim ${i + 1} (${c.kind}): ${c.text}`, ...c.sources.flatMap(source)].join("\n")).join("\n\n")
}

/** Merges the support answer into the deterministic verdicts: partly -> rewrite (with a suggestion), no -> block. */
export function withSupport(verdicts: Verdict[], asked: Claim[], answer: SupportAnswer): Verdict[] {
  return verdicts.map((v) => {
    const n = asked.findIndex((c) => c.id === v.claimId) + 1
    const check = n > 0 ? answer.checks.find((c) => c.claim === n) : undefined
    if (!check || check.support === "yes") return v
    const reason = check.reason || "the quotes don't say this"
    return check.support === "partly"
      ? { ...v, verdict: "rewrite", check: "support", reason, suggestion: check.rewrite || undefined }
      : { ...v, verdict: "block", check: "support", reason }
  })
}

/** What goes back to the writer or Profiler for claims the Critic stopped. Numbers, not ids: models copy them reliably. */
export function feedbackMessage(failed: Claim[], verdicts: Verdict[]): string {
  const items = failed.map((c, i) => {
    const v = verdicts.find((x) => x.claimId === c.id)
    return [
      `Claim ${i + 1} (subject ${c.subject}, ${c.kind}): ${c.text}`,
      ...c.sources.map((s) => `  source ${s.id} ${s.field}: "${s.quote}"`),
      `  fact checker: ${v?.check ?? "?"}: ${v?.reason ?? "not passed"}`,
      ...(v?.suggestion ? [`  suggested sentence: ${v.suggestion}`] : []),
    ].join("\n")
  })
  return [
    "The fact checker did not pass these claims. Fix each one: change the sentence so its quotes say everything it says, or pick quotes that do. Leave a claim out to drop it.",
    "Each quote is 5 to 20 consecutive words copied exactly from the named field of a record above. A number in the sentence must be in one of its quotes. Describe work, never praise people.",
    "Answer with JSON: claims, each with claim (its number below), text and sources.",
    "",
    ...items,
  ].join("\n")
}

/** The fixed claims, keeping each one's id, subject and kind. A claim the model left out is not returned (dropped). */
export function applyRewrites(failed: Claim[], answer: ClaimRewrites | undefined): Claim[] {
  return failed.flatMap((c, i) => {
    const fix = answer?.claims.find((r) => r.claim === i + 1)
    return fix && fix.text.trim() ? [{ ...c, text: fix.text, sources: fix.sources }] : []
  })
}

export type CheckRequest = { pairId: string; claims: Claim[]; attempt?: number }

/**
 * Checks every claim in `prenup.critic.check`: the deterministic checks, then (if on) one cheap-model support check
 * for the facts and inferences that passed them, in one call per request. Emits one `prenup.critic.verdict` per claim,
 * then `prenup.critic.done`. Term claims skip the support check: code writes them from the term sheet.
 */
export function createCritic(ctx: CriticContext, { support = true } = {}): Human {
  const critic: Human = createHuman({
    name: "critic",
    capabilities: ["check-claims"],
    handlers: [{ specification: on("prenup.critic.check"), processor: { apply: ({ event }) => check(event.payload as CheckRequest) } }],
  })

  function check({ pairId, claims, attempt = 1 }: CheckRequest): void {
    const verdicts = claims.map((claim) => checkClaim(claim, ctx))
    const asked = claims.filter((c, i) => verdicts[i].verdict === "pass" && c.kind !== "term")
    if (!support || asked.length === 0) return finish(pairId, attempt, verdicts, "skipped")

    const agent = createAgent({
      name: "critic:support",
      capabilities: ["check-support"],
      instruction: SUPPORT_INSTRUCTION,
      tools: [],
      handlers: [
        {
          specification: own("model.answer"),
          processor: {
            apply: ({ event }) => {
              const parsed = SupportAnswer.safeParse(parseJson(answerText(event.payload)))
              // An unreadable answer leaves the deterministic verdicts; the trace says the support check failed.
              finish(pairId, attempt, parsed.success ? withSupport(verdicts, asked, parsed.data) : verdicts, parsed.success ? "checked" : "failed")
            },
          },
        },
      ],
    })
    join(agent)
    runLoop(agent.getId(), supportMessage(asked, ctx), {
      model: MODELS.cheap,
      maxOutputTokens: MAX_OUTPUT.support,
      context: agent.getMemory().getContext(),
      tools: [],
      structuredOutput: structuredOutput("support_check", SupportAnswer, MODELS.cheap),
    })
  }

  function finish(pairId: string, attempt: number, verdicts: Verdict[], supportCheck: "checked" | "failed" | "skipped"): void {
    const emit = (type: string, payload: unknown) => sendEvent(SemanticEvent.create(type, critic.getId(), payload), critic.getId())
    for (const verdict of verdicts) emit("prenup.critic.verdict", { pairId, attempt, ...verdict })
    emit("prenup.critic.done", { pairId, attempt, verdicts, supportCheck })
  }

  return critic
}
