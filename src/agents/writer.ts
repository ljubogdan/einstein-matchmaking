import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createAgent, SemanticEvent, type Agent } from "@mozaik-ai/core"
import { answerText, parseJson } from "../llm/answer"
import { EFFORT, MAX_OUTPUT, MODELS } from "../models"
import { renderProposal } from "../proposal/render"
import { termClaims } from "../proposal/terms"
import { on, own, runLoop, sendEvent, type Board } from "../runtime"
import { CLAIM_SECTIONS, ClaimRewrites, Draft, type Claim } from "../schema/claim"
import { structuredOutput } from "../schema/model-schema"
import type { ProfileCard } from "../schema/profile"
import { applyRewrites, feedbackMessage, type Verdict } from "./critic"
import { checkedFindings, evidencePack, type Pair } from "../tools/cards"
import type { Dataset } from "../tools/dataset"

const INSTRUCTION = `You write one-page collaboration proposals between a company and a university researcher, for an engineer or manager to read.
You get records (JSON lines, each with an id) and the agreed term sheet. Answer with the draft JSON.
- problem, companyBrings, universityBrings, whyThisPair: 2 or 3 claims each. A claim is one plain sentence, its subject id, kind (fact or inference) and sources.
- subject: the challenge id for the problem, the company id for what the company brings, the researcher id for what the university brings, the pair id for why this pair.
- Each source has the record id, the field (the JSON key, e.g. "abstract", "rd_capacity", "detail") and a quote: 5 to 20 consecutive words copied exactly from that field.
- A sentence may contain a number only if the number is in one of its quotes.
- Describe work, never praise people. No names of people.
- Write your own sentences in the third person: no "we" or "our", and no quotation marks. The exact words go in the source's quote.
- State facts plainly, keeping the source's own scope. If a source names two things, name two; if it says "consistent with", don't say "identified" or "dominant". No "specifically", "entirely" or "already" unless the source says so, and no adjectives or benefits of your own such as large, real, unusual, enabling, reducing risk.
- problem: use the challenge's own numbers: how long, how much, what it costs the company. Cite "text" for what is in "text" and "detail" for what is in "detail".
- companyBrings: the concrete assets the project will use: data and how much of it, equipment, people's time. Each sentence quotes the field that names that asset.
- whyThisPair: one claim of kind inference says what each side lacks that the other has, so why neither can do this alone.
- researchQuestions (2 to 4) and plan (3 or 4 phases) describe future work and state no facts about the records. Every research question is worked on in a named plan phase. A plan never says IP is transferred: results are delivered, and ownership stays as the term sheet says.
- title: the outcome for the company, in plain words a manager would use, e.g. "Seeing seed quality before it's bought". No numbers and no method names.`

/**
 * Drafts the proposal for one pair once its terms are agreed and sends every claim to the Critic. Claims it stops go
 * back to this writer once, with the reasons (feedback loop 3); the fixes are checked again, what still fails is
 * dropped, and the page is rendered from what passed.
 */
export function createWriter(pair: Pair, board: Board, data: Dataset, profile: ProfileCard, outDir = "out/proposals"): Agent {
  let draft: Draft | undefined
  let claims: Claim[] = []
  let failed: Claim[] = [] // the claims sent back for a rewrite
  let first: Verdict[] | undefined // verdicts before the rewrite
  const path = `${outDir}/${pair.pairId}.md`

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
              `Pair id: ${pair.pairId}`,
              `Records:\n${evidencePack(pair, profile, data)}`,
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
      { specification: own("model.answer"), processor: { apply: ({ event }) => void (cancelled() || (first ? rewritten(answerText(event.payload)) : drafted(answerText(event.payload)))) } },
      {
        specification: on("prenup.critic.done"),
        processor: {
          apply: ({ event }) => {
            const { pairId, verdicts } = event.payload as { pairId: string; verdicts: Verdict[] }
            if (pairId !== pair.pairId || !draft || cancelled()) return
            if (first) return publish(first.map((v) => verdicts.find((w) => w.claimId === v.claimId) ?? v))
            first = verdicts
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
    claims = [
      ...CLAIM_SECTIONS.flatMap((section) => draft![section].map((c, i): Claim => ({ ...c, id: `${pair.pairId}/${section}/${i + 1}` }))),
      ...termClaims(agreed, pair.researcher.id),
    ]
    emit("prenup.critic.check", { pairId: pair.pairId, claims })
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
    writeFileSync(path, renderProposal({ pair, draft, claims, verdicts, first: first ?? verdicts, moves, agreed }))
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
