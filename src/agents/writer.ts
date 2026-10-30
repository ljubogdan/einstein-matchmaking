import { mkdirSync, writeFileSync } from "node:fs"
import { createAgent, SemanticEvent, type Agent } from "@mozaik-ai/core"
import { answerText, parseJson } from "../llm/answer"
import { EFFORT, MAX_OUTPUT, MODELS } from "../models"
import { renderProposal } from "../proposal/render"
import { termClaims } from "../proposal/terms"
import { on, own, runLoop, sendEvent, type Board } from "../runtime"
import { CLAIM_SECTIONS, Draft, type Claim } from "../schema/claim"
import { structuredOutput } from "../schema/model-schema"
import type { Verdict } from "./critic"
import { evidencePack, type Pair } from "../tools/cards"
import type { Dataset } from "../tools/dataset"

const INSTRUCTION = `You write one-page collaboration proposals between a company and a university researcher, for an engineer or manager to read.
You get records (JSON lines, each with an id) and the agreed term sheet. Answer with the draft JSON.
- problem, companyBrings, universityBrings, whyThisPair: 2 or 3 claims each. A claim is one plain sentence, its subject id, kind (fact or inference) and sources.
- subject: the challenge id for the problem, the company id for what the company brings, the researcher id for what the university brings, the pair id for why this pair.
- Each source has the record id, the field (the JSON key, e.g. "abstract", "rd_capacity", "detail") and a quote: 5 to 20 consecutive words copied exactly from that field.
- A sentence may contain a number only if the number is in one of its quotes.
- Describe work, never praise people. No names of people.
- researchQuestions (2 to 4) and plan (3 or 4 phases) describe future work and state no facts about the records.
- title: the outcome, not the method, no numbers.`

/** Drafts the proposal for one pair once its terms are agreed, sends every claim to the Critic, renders what passed. */
export function createWriter(pair: Pair, board: Board, data: Dataset, outDir = "out/proposals"): Agent {
  let draft: Draft | undefined
  let claims: Claim[] = []

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
            if (pairId !== pair.pairId) return
            runLoop(agent.getId(), `Pair id: ${pair.pairId}\n\nRecords:\n${evidencePack(pair, data)}\n\nAgreed term sheet:\n${JSON.stringify(sheet)}`, {
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
            const parsed = Draft.safeParse(parseJson(answerText(event.payload)))
            if (!parsed.success) return emit("prenup.proposal.failed", { pairId: pair.pairId, reason: `invalid draft: ${parsed.error.issues[0]?.message}` })
            draft = parsed.data
            const agreed = board.negotiations.get(pair.pairId)?.at(-1)
            if (!agreed) return emit("prenup.proposal.failed", { pairId: pair.pairId, reason: "no agreed move on the board" })
            claims = [
              ...CLAIM_SECTIONS.flatMap((section) => draft![section].map((c, i): Claim => ({ ...c, id: `${pair.pairId}/${section}/${i + 1}` }))),
              ...termClaims(agreed, pair.researcher.id),
            ]
            emit("prenup.critic.check", { pairId: pair.pairId, claims })
          },
        },
      },
      {
        specification: on("prenup.critic.done"),
        processor: {
          apply: ({ event }) => {
            const { pairId, verdicts } = event.payload as { pairId: string; verdicts: Verdict[] }
            const moves = board.negotiations.get(pair.pairId) ?? []
            const agreed = moves.at(-1)
            if (pairId !== pair.pairId || !draft || !agreed) return
            const path = `${outDir}/${pair.pairId}.md`
            mkdirSync(outDir, { recursive: true })
            writeFileSync(path, renderProposal({ pair, draft, claims, verdicts, moves, agreed }))
            const blocked = verdicts.filter((v) => v.verdict === "block").length
            emit("prenup.proposal.ready", { pairId: pair.pairId, path, claims: verdicts.length, blocked })
          },
        },
      },
    ],
  })

  function emit(type: string, payload: unknown): void {
    sendEvent(SemanticEvent.create(type, agent.getId(), payload), agent.getId())
  }

  return agent
}
