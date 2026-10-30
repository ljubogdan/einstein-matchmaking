// npm run find-contested: researchers who are the first pairable search hit for two or more challenges.
// Code only, no model: the query is the challenge's one-line text (the detail drowns it in generic words; the Analyst's terms
// come later, in the run). Hubs that top many challenges are artifacts of shared vocabulary, so show 2-3-challenge cases first.
import { Dataset } from "../src/tools/dataset"
import { allowedEngagements, trapFlags } from "../src/tools/profile"
import { PublicationIndex, type Candidate } from "../src/tools/search"

const data = Dataset.load()
const index = new PublicationIndex(data)
const pairable = (c: Candidate) => {
  const r = data.researchers.get(c.researcherId)!
  return allowedEngagements(r).length > 0 && !trapFlags(r, data).some((f) => f.kind === "identity_conflict")
}

const wanted = new Map<string, { challengeId: string; score: number; next?: Candidate }[]>()
for (const [challengeId, ch] of data.challenges) {
  const [first, next] = index.shortlist(ch.text, 5).filter(pairable)
  if (first) wanted.set(first.researcherId, [...(wanted.get(first.researcherId) ?? []), { challengeId, score: first.score, next }])
}

const contested = [...wanted].filter(([, list]) => new Set(list.map((w) => data.challengeCompany.get(w.challengeId))).size >= 2)
console.log(`${contested.length} researchers are the first pairable hit for challenges of 2+ companies (of ${data.challenges.size} challenges)`)
const rank = ([id, list]: (typeof contested)[number]) => (list.length <= 3 ? 0 : 2) + (data.researchers.get(id)!.patents.length > 0 ? 0 : 1)
for (const [researcherId, list] of contested.sort((a, b) => rank(a) - rank(b) || b[1].length - a[1].length).slice(0, Number(process.argv[2] ?? 15))) {
  const r = data.researchers.get(researcherId)!
  console.log(`${researcherId} patents=${r.patents.length} allowed=${allowedEngagements(r).join(",")}`)
  for (const w of list) console.log(`  ${w.challengeId} score=${w.score.toFixed(0)} next=${w.next ? `${w.next.researcherId} (${w.next.score.toFixed(0)})` : "none"}`)
}
