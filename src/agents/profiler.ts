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
import { checkClaim } from "./critic"

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
 * (memory never crosses researchers). Emits `prenup.profile.ready`.
 */
export function createProfiler(data: Dataset, cache: ResultCache): Human {
  const profiler: Human = createHuman({
    name: "profiler",
    capabilities: ["profile-researcher"],
    handlers: [
      {
        specification: on("prenup.shortlist.ready"),
        processor: {
          apply: ({ event }) => {
            const { challengeId, candidates } = event.payload as { challengeId: string; candidates: Candidate[] }
            for (const candidate of candidates) profile(challengeId, candidate)
          },
        },
      },
    ],
  })

  function profile(challengeId: string, candidate: Candidate): void {
    const name = `${challengeId}__${candidate.researcherId}`
    const message = profileMessage(data, challengeId, candidate)
    const key = ResultCache.key(MODELS.cheap, INSTRUCTION, message)
    const cached = cache.get("profile", name, key, ProfilerAnswer)
    if (cached) return emit(profiler.getId(), "prenup.profile.ready", card(challengeId, candidate, cached, true))

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
              emit(agent.getId(), "prenup.profile.ready", card(challengeId, candidate, answer, false))
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

  // The model reads the evidence; code adds availability and trap flags, and the Critic's checks decide which facts stay.
  function card(challengeId: string, candidate: Candidate, answer: ProfilerAnswer, cached: boolean): ProfileCard {
    const r = data.researchers.get(candidate.researcherId)!
    const claims = answer.expertise.map((c, i): Claim => ({ ...c, id: `profile:${challengeId}__${r.id}/${i + 1}`, subject: r.id, kind: "fact" }))
    const passed = claims.filter((claim) => checkClaim(claim, { data, move: () => undefined }).verdict === "pass")
    return {
      challengeId,
      researcherId: r.id,
      publications: candidate.publications.map((hit) => hit.id),
      availability: availabilityOf(r).availability,
      allowedEngagements: allowedEngagements(r),
      flags: trapFlags(r, data),
      expertise: passed,
      blocked: claims.length - passed.length,
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
