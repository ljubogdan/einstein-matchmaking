import { createAgent, createHuman, SemanticEvent, type Human } from "@mozaik-ai/core"
import { answerText, parseJson } from "../llm/answer"
import { ResultCache } from "../llm/cache"
import { MAX_OUTPUT, MODELS } from "../models"
import { join, on, own, runLoop, sendEvent } from "../runtime"
import type { Claim } from "../schema/claim"
import { structuredOutput } from "../schema/model-schema"
import { ProfilerAnswer, type ProfileCard } from "../schema/profile"
import type { Dataset } from "../tools/dataset"
import { allowedEngagements, availabilityOf, trapFlags } from "../tools/profile"
import type { Candidate } from "../tools/search"
import type { Verdict } from "./critic"

const INSTRUCTION = `You profile one university researcher for one company challenge, from the records only. Answer with JSON:
- expertise: 2 or 3 claims about the researcher's work that matter for this challenge. A claim is one plain sentence and its sources.
  Each source has the record id, the field (the JSON key, e.g. "abstract", "keywords", "bio") and a quote: 5 to 20 consecutive words copied exactly from that field.
  A sentence may contain a number only if the number is in one of its quotes. Describe work, never praise people. No names of people.
- fit: "strong" if the publications address the challenge's core problem; "partial" if they cover a neighbouring method or domain; "none" if the overlap is only shared words.
- fitReason: one sentence that cites record ids in brackets, e.g. [SYN-PUB-00001].`

/** What the Profiler reads: the challenge, the researcher's work (notes stay out: availability is code's job), the search hits. */
export function profileMessage(data: Dataset, challengeId: string, candidate: Candidate): string {
  const challenge = data.challenges.get(challengeId)!
  const r = data.researchers.get(candidate.researcherId)!
  const researcher = { id: r.id, title: r.title, faculty: r.faculty, department: r.department, fields: r.fields, keywords: r.keywords, bio: r.bio, industry_experience: r.industry_experience }
  const publications = candidate.publications
    .map((hit) => data.publications.get(hit.id)!)
    .map((p) => ({ id: p.id, title: p.title, year: p.year, keywords: p.keywords, abstract: p.abstract }))
  return [
    `Challenge ${challenge.id}: ${challenge.text}`,
    `Detail: ${challenge.detail}`,
    "",
    "Records:",
    ...[researcher, ...publications].map((record) => JSON.stringify(record)),
  ].join("\n")
}

/**
 * On `prenup.shortlist.ready`: one card per candidate, from the cache or a fresh cheap agent per candidate
 * (memory never crosses researchers). Its claims go to the Critic (`prenup.critic.check`); then `prenup.profile.ready`.
 */
export function createProfiler(data: Dataset, cache: ResultCache): Human {
  const awaiting = new Map<string, (verdicts: Verdict[]) => void>() // Critic check id -> the card waiting for its verdicts

  const profiler: Human = createHuman({
    name: "profiler",
    capabilities: ["profile-researcher"],
    handlers: [
      {
        specification: on("prenup.shortlist.ready"),
        processor: {
          apply: ({ event }) => {
            const { challengeId, candidates } = event.payload as { challengeId: string; candidates: Candidate[] }
            candidates.forEach((candidate, i) => profile(challengeId, candidate, i + 1))
          },
        },
      },
      {
        specification: on("prenup.critic.done"),
        processor: {
          apply: ({ event }) => {
            const { pairId, verdicts } = event.payload as { pairId: string; verdicts: Verdict[] }
            awaiting.get(pairId)?.(verdicts)
            awaiting.delete(pairId)
          },
        },
      },
    ],
  })

  function profile(challengeId: string, candidate: Candidate, rank: number): void {
    const name = `${challengeId}__${candidate.researcherId}`
    const message = profileMessage(data, challengeId, candidate)
    const key = ResultCache.key(MODELS.cheap, INSTRUCTION, message)
    const cached = cache.get("profile", name, key, ProfilerAnswer)
    if (cached) return void setImmediate(() => submit(profiler.getId(), challengeId, candidate, rank, cached, true)) // next tick, like the analyst

    const agent = createAgent({
      name: `profiler:${candidate.researcherId}`,
      capabilities: ["profile-researcher"],
      instruction: INSTRUCTION,
      tools: [],
      handlers: [
        {
          specification: own("model.answer"),
          processor: {
            apply: ({ event }) => {
              const parsed = ProfilerAnswer.safeParse(parseJson(answerText(event.payload)))
              const answer = parsed.success ? parsed.data : { expertise: [], fit: "none" as const, fitReason: `invalid profiler answer: ${parsed.error.issues[0]?.message}` }
              if (parsed.success) cache.set("profile", name, key, answer)
              submit(agent.getId(), challengeId, candidate, rank, answer, false)
            },
          },
        },
      ],
    })
    join(agent)
    runLoop(agent.getId(), message, {
      model: MODELS.cheap,
      maxOutputTokens: MAX_OUTPUT.profile,
      context: agent.getMemory().getContext(),
      tools: [],
      structuredOutput: structuredOutput("researcher_profile", ProfilerAnswer, MODELS.cheap),
    })
  }

  // The model reads the evidence; the Critic decides which facts stay; code adds availability and trap flags.
  function submit(producerId: string, challengeId: string, candidate: Candidate, rank: number, answer: ProfilerAnswer, cached: boolean): void {
    const r = data.researchers.get(candidate.researcherId)!
    const checkId = `profile:${challengeId}__${r.id}`
    const claims = answer.expertise.map((c, i): Claim => ({ ...c, id: `${checkId}/${i + 1}`, subject: r.id, kind: "fact" }))
    awaiting.set(checkId, (verdicts) => {
      const passed = claims.filter((claim) => verdicts.some((v) => v.claimId === claim.id && v.verdict === "pass"))
      emit(producerId, "prenup.profile.ready", card(challengeId, candidate, rank, answer, cached, passed, claims.length - passed.length))
    })
    emit(producerId, "prenup.critic.check", { pairId: checkId, claims })
  }

  function card(challengeId: string, candidate: Candidate, rank: number, answer: ProfilerAnswer, cached: boolean, expertise: Claim[], blocked: number): ProfileCard {
    const r = data.researchers.get(candidate.researcherId)!
    return {
      challengeId,
      researcherId: r.id,
      rank,
      publications: candidate.publications.map((hit) => hit.id),
      availability: availabilityOf(r).availability,
      allowedEngagements: allowedEngagements(r),
      flags: trapFlags(r, data),
      expertise,
      blocked,
      fit: answer.fit,
      fitReason: answer.fitReason,
      cached,
    }
  }

  return profiler
}

function emit(producerId: string, type: string, payload: unknown): void {
  sendEvent(SemanticEvent.create(type, producerId, payload), producerId)
}
