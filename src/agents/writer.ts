import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createAgent, SemanticEvent, type Agent } from "@mozaik-ai/core"
import { answerText, parseJson } from "../llm/answer"
import { EFFORT, MAX_OUTPUT, MODELS } from "../models"
import { renderProposal } from "../proposal/render"
import { termClaims } from "../proposal/terms"
import { join, on, own, runLoop, sendEvent, type Board } from "../runtime"
import { CLAIM_SECTIONS, ClaimRewrites, Draft, PlanReview, PlanRewrite, type Claim } from "../schema/claim"
import { structuredOutput } from "../schema/model-schema"
import type { ProfileCard } from "../schema/profile"
import { applyRewrites, feedbackMessage, type Verdict } from "./critic"
import { checkedFindings, evidencePack, type Pair } from "../tools/cards"
import type { Dataset } from "../tools/dataset"

const INSTRUCTION = `You write one-page collaboration proposals between a company and a university researcher, for an engineer or manager to read.
You get records (JSON lines, each with an id) and the agreed term sheet. Answer with the draft JSON.
- problem and whyThisPair: 2 or 3 claims. companyBrings, universityBrings: 2 claims each. A claim is one plain sentence of at most 30 words, its subject id, kind (fact or inference) and sources.
- subject: the challenge id for the problem, the company id for what the company brings, the researcher id for what the university brings, the pair id for why this pair.
- Each source has the record id, the field (the JSON key, e.g. "abstract", "rd_capacity", "detail") and a quote: 5 to 20 consecutive words copied exactly from that field.
- A sentence may contain a number only if the number is in one of its quotes.
- Describe work, never praise people. No names of people.
- Write your own sentences in the third person: no "we" or "our", and no quotation marks. The exact words go in the source's quote.
- State facts plainly, keeping the source's own scope. If a source names two things, name two; if it says "consistent with", don't say "identified" or "dominant". No "specifically", "entirely" or "already" unless the source says so, and no adjectives or benefits of your own such as large, real, unusual, enabling, reducing risk.
- problem: use the challenge's own numbers: how long, how much, what it costs the company. Cite "text" for what is in "text" and "detail" for what is in "detail".
- companyBrings: the concrete assets the project will use: data and how much of it, equipment, people's time. Each sentence quotes the field that names that asset.
- whyThisPair: one claim of kind inference says why neither side can do this alone, built only from facts the records state: what the challenge says the company lacks or needs (quote its text or detail), what the researcher's records show they work on (quote them), and what the company has that the research needs (quote it). Never say a side has not done or does not have something unless a quote says so.
- whyThisPair also names the core work from the fit review and which side does it. If the fit review says "partial", name the missing part and which side covers it.
- researchQuestions (2 to 4, at most 30 words each, one sentence with no conditions) and plan (3 or 4 phases) describe future work and state no facts about the records. Every research question is worked on in a named plan phase, and says what its answer is measured against, independent of the method itself, e.g. "measured against three technicians' consensus on 2,000 historical lots". Questions are about the research, never about contracts or paperwork. A plan never says IP is transferred: results are delivered, and ownership stays as the term sheet says.
- plan: at most 35 words per cell, no notes or conditions in a cell. Each result is something a person can hold: a dataset, a paper, a prototype on one line, a decision. A measure must be possible with that phase's data: no detection rate without examples of what is detected, so create them where needed (for example, scripted faults on a test bench the company has) and say so. Each phase names who does the work, and it must be work that side's records show. Give a side equipment or data only if a record names it; what nobody has yet, the plan buys, rents or creates, and says so.
- If the term sheet says industrial_phd: plan by year over three years, with papers and the thesis among the results, and a trial at the company in the last year; candidate: one line saying who is hired, e.g. "a master's graduate in computer engineering, employed by the company for the three years". Otherwise candidate is "".
- title: the outcome for the company, in plain words a manager would use, e.g. "Seeing seed quality before it's bought". No numbers and no method names.`

const REVIEW_INSTRUCTION = `You read a draft research plan before a company and a researcher meet, as a sceptical company technical lead and a sceptical professor at once. You get the records, the agreed term sheet and the draft research questions and plan. Answer with JSON:
- issues: at most 4, only what would really stop or embarrass the meeting: a measure the phase's data can't produce, work that the side named for it has no record of doing or whose notes rule it out, access or data the plan assumes but nobody offered, a timeline the work can't fit, a question nobody could answer, a measure that only checks the method against itself (its own score or error, or data with only normal cases, can't show that it detects anything). Each has where (the phase or question), problem and fix, in one sentence each. New work the plan creates, such as test data or scripted faults on equipment a side has, is not an assumption. Review only the questions and plan, not the terms, and every fix must be a change to them. No issues is a fine answer; don't invent any, and don't comment on style.
- unconfirmed: items of the term sheet's contributions, and nothing else, for equipment, compute, data or staff that no field of that side's records names. A field that names the thing counts, even if it doesn't promise it for this project. Copy each item's words from the term sheet.`

/**
 * Drafts the proposal for one pair once its terms are agreed. A fresh plan reviewer reads the questions and plan, which
 * state no facts and so never reach the Critic; what it finds goes back to this writer once. Then every claim goes to the
 * Critic. Claims it stops go back to this writer once, with the reasons (feedback loop 3); the fixes are checked again,
 * what still fails is dropped, and the page is rendered from what passed.
 */
export function createWriter(pair: Pair, board: Board, data: Dataset, profile: ProfileCard, outDir = "out/proposals"): Agent {
  let draft: Draft | undefined
  let claims: Claim[] = []
  let failed: Claim[] = [] // the claims sent back for a rewrite
  let first: Verdict[] | undefined // verdicts before the rewrite
  let latest: Verdict[] = [] // verdicts as they stand
  let suggested = false // the support check's own sentences have had their one check
  let stage: "draft" | "plan" | "claims" = "draft" // which answer this writer is waiting for
  let review: PlanReview = { issues: [], unconfirmed: [] }
  const path = `${outDir}/${pair.pairId}.md`
  const records = () => `Pair id: ${pair.pairId}\n\nFit review: ${profile.fit}. ${profile.fitReason}\n\nRecords:\n${evidencePack(pair, profile, data)}`

  const agent: Agent = createAgent({
    name: "writer",
    capabilities: ["write-proposal"],
    instruction: INSTRUCTION,
    tools: [],
    handlers: [
      {
        specification: on("prenup.negotiation.agreed"),
        processor: {
          apply: ({ event }) => {
            const { pairId, sheet } = event.payload as { pairId: string; sheet: unknown }
            if (pairId !== pair.pairId || cancelled()) return
            const message = [
              records(),
              `Checked findings about the researcher (the Critic verified their quotes; reuse them):\n${checkedFindings(profile)}`,
              `Agreed term sheet:\n${JSON.stringify(sheet)}`,
            ].join("\n\n")
            runLoop(agent.getId(), message, {
              model: MODELS.strong,
              reasoningEffort: EFFORT.write,
              maxOutputTokens: MAX_OUTPUT.write,
              context: agent.getMemory().getContext(),
              tools: [],
              structuredOutput: structuredOutput("proposal_draft", Draft, MODELS.strong),
            })
          },
        },
      },
      {
        specification: own("model.answer"),
        processor: {
          apply: ({ event }) => {
            if (cancelled()) return
            const text = answerText(event.payload)
            if (stage === "draft") drafted(text)
            else if (stage === "plan") replanned(text)
            else rewritten(text)
          },
        },
      },
      {
        specification: on("prenup.critic.done"),
        processor: {
          apply: ({ event }) => {
            const { pairId, verdicts } = event.payload as { pairId: string; verdicts: Verdict[] }
            if (pairId !== pair.pairId || !draft || cancelled()) return
            if (first) {
              latest = latest.map((v) => verdicts.find((w) => w.claimId === v.claimId) ?? v)
              return suggested || !trySuggestions() ? publish(latest) : undefined
            }
            first = latest = verdicts
            failed = claims.filter((c) => c.kind !== "term" && verdicts.find((v) => v.claimId === c.id)?.verdict !== "pass")
            if (failed.length === 0) return publish(verdicts)
            runLoop(agent.getId(), feedbackMessage(failed, verdicts), {
              model: MODELS.strong,
              reasoningEffort: EFFORT.rewrite,
              maxOutputTokens: MAX_OUTPUT.rewrite,
              context: agent.getMemory().getContext(),
              tools: [],
              structuredOutput: structuredOutput("claim_rewrites", ClaimRewrites, MODELS.strong),
            })
          },
        },
      },
      {
        // The Arbiter gave the researcher to another challenge: a proposal already written is withdrawn.
        specification: on("prenup.pair.cancelled"),
        processor: { apply: ({ event }) => void ((event.payload as { pairId: string }).pairId === pair.pairId && existsSync(path) && rmSync(path)) },
      },
    ],
  })

  function drafted(text: string): void {
    const parsed = Draft.safeParse(parseJson(text))
    if (!parsed.success) return emit("prenup.proposal.failed", { pairId: pair.pairId, reason: `invalid draft: ${parsed.error.issues[0]?.message}` })
    draft = parsed.data
    const agreed = board.negotiations.get(pair.pairId)?.at(-1)
    if (!agreed) return emit("prenup.proposal.failed", { pairId: pair.pairId, reason: "no agreed move on the board" })
    const reviewer = createAgent({
      name: `plan-reviewer:${pair.pairId}`,
      capabilities: ["review-plan"],
      instruction: REVIEW_INSTRUCTION,
      tools: [],
      handlers: [{ specification: own("model.answer"), processor: { apply: ({ event }) => reviewed(answerText(event.payload)) } }],
    })
    join(reviewer)
    const { researchQuestions, plan, candidate } = draft
    runLoop(reviewer.getId(), [records(), `Agreed term sheet:\n${JSON.stringify(agreed.sheet)}`, `Draft:\n${JSON.stringify({ candidate, researchQuestions, plan })}`].join("\n\n"), {
      model: MODELS.strong,
      reasoningEffort: EFFORT.review,
      maxOutputTokens: MAX_OUTPUT.planReview,
      context: reviewer.getMemory().getContext(),
      tools: [],
      structuredOutput: structuredOutput("plan_review", PlanReview, MODELS.strong),
    })
  }

  // An unreadable review leaves the draft as it is; the trace says so.
  function reviewed(text: string): void {
    if (cancelled()) return
    const parsed = PlanReview.safeParse(parseJson(text))
    if (parsed.success) review = parsed.data
    emit("prenup.plan.reviewed", { pairId: pair.pairId, ...review, check: parsed.success ? "checked" : "failed" })
    if (review.issues.length === 0) return check()
    stage = "plan"
    const feedback = review.issues.map((issue, i) => `${i + 1}. ${issue.where}: ${issue.problem} Fix: ${issue.fix}`).join("\n")
    runLoop(agent.getId(), `A reviewer found these problems in your research questions and plan. Fix each one, keeping every rule for questions and plan: don't give a side equipment or data no record names. Answer with JSON: researchQuestions, plan and candidate, whole.\n${feedback}`, {
      model: MODELS.strong,
      reasoningEffort: EFFORT.rewrite,
      maxOutputTokens: MAX_OUTPUT.rewrite,
      context: agent.getMemory().getContext(),
      tools: [],
      structuredOutput: structuredOutput("plan_rewrite", PlanRewrite, MODELS.strong),
    })
  }

  function replanned(text: string): void {
    const parsed = PlanRewrite.safeParse(parseJson(text))
    if (parsed.success) draft = { ...draft!, ...parsed.data }
    check()
  }

  function check(): void {
    const agreed = board.negotiations.get(pair.pairId)!.at(-1)!
    stage = "claims"
    claims = [
      ...CLAIM_SECTIONS.flatMap((section) => draft![section].map((c, i): Claim => ({ ...c, id: `${pair.pairId}/${section}/${i + 1}` }))),
      ...termClaims(agreed, pair.researcher.id),
    ]
    emit("prenup.critic.check", { pairId: pair.pairId, claims })
  }

  // Still stopped after the rewrite: the support check's own shorter sentence gets one check before the claim is dropped.
  function trySuggestions(): boolean {
    suggested = true
    const retries = latest.flatMap((v) => {
      const claim = claims.find((c) => c.id === v.claimId)
      return v.verdict === "rewrite" && v.suggestion && claim ? [{ ...claim, text: v.suggestion }] : []
    })
    if (retries.length === 0) return false
    claims = claims.map((c) => retries.find((r) => r.id === c.id) ?? c)
    emit("prenup.critic.check", { pairId: pair.pairId, claims: retries, attempt: 3 })
    return true
  }

  // The fixes replace their claims and go to the Critic again; a claim left out keeps its first verdict.
  function rewritten(text: string): void {
    const parsed = ClaimRewrites.safeParse(parseJson(text))
    const fixes = applyRewrites(failed, parsed.success ? parsed.data : undefined)
    claims = claims.map((c) => fixes.find((f) => f.id === c.id) ?? c)
    emit("prenup.writer.rewrote", { pairId: pair.pairId, sentBack: failed.map((c) => c.id), rewritten: fixes.map((c) => c.id) })
    if (fixes.length === 0) return publish(first!)
    emit("prenup.critic.check", { pairId: pair.pairId, claims: fixes, attempt: 2 })
  }

  function publish(verdicts: Verdict[]): void {
    const moves = board.negotiations.get(pair.pairId) ?? []
    const agreed = moves.at(-1)
    if (!draft || !agreed) return
    for (const v of verdicts.filter((v) => v.verdict !== "pass")) emit("prenup.claim.dropped", { pairId: pair.pairId, claimId: v.claimId, check: v.check, reason: v.reason })
    mkdirSync(outDir, { recursive: true })
    writeFileSync(path, renderProposal({ pair, draft, claims, verdicts, first: first ?? verdicts, moves, agreed, review }))
    const stopped = (first ?? verdicts).filter((v) => v.verdict !== "pass").length
    const dropped = verdicts.filter((v) => v.verdict !== "pass").length
    emit("prenup.proposal.ready", { pairId: pair.pairId, path, claims: verdicts.length, stopped, fixed: stopped - dropped, dropped })
  }

  function cancelled(): boolean {
    return board.cancelled.has(pair.pairId)
  }

  function emit(type: string, payload: unknown): void {
    sendEvent(SemanticEvent.create(type, agent.getId(), payload), agent.getId())
  }

  return agent
}
