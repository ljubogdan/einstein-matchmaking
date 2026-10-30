import type { Challenge, Company, Dataset, Publication, Researcher } from "./dataset"
import { normalize } from "./normalize"
import { allowedEngagements, availabilityOf } from "./profile"

export type Pair = { pairId: string; challenge: Challenge; company: Company; researcher: Researcher }

export function makePair(data: Dataset, challengeId: string, researcherId: string): Pair {
  const challenge = data.challenges.get(challengeId)
  const company = data.companies.get(data.challengeCompany.get(challengeId) ?? "")
  const researcher = data.researchers.get(researcherId)
  if (!challenge || !company || !researcher) throw new Error(`unknown pair ${challengeId} / ${researcherId}`)
  return { pairId: `${challengeId}__${researcherId}`, challenge, company, researcher }
}

/** The researcher's publications that share the most words with the challenge (search proper arrives in M2). */
export function topPublications(pair: Pair, data: Dataset, n: number): Publication[] {
  const words = (text: string) => new Set(normalize(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 4))
  const challengeWords = words(`${pair.challenge.text} ${pair.challenge.detail}`)
  const score = (p: Publication) => [...words(`${p.title} ${p.abstract} ${p.keywords.join(" ")}`)].filter((w) => challengeWords.has(w)).length
  return pair.researcher.publications
    .map((id) => data.publications.get(id))
    .filter((p): p is Publication => p !== undefined && p.authors.some((a) => a.researcher_id === pair.researcher.id))
    .sort((a, b) => score(b) - score(a) || b.year - a.year)
    .slice(0, n)
}

const line = (label: string, ref: string, value: string | string[]) =>
  `${label} [${ref}]: ${Array.isArray(value) ? value.join("; ") || "none" : value || "none"}`

/** The company negotiator's position: its own record plus the researcher's public profile. */
export function companyCard(pair: Pair): string {
  const { company: c, challenge: ch, researcher: r } = pair
  return [
    `Company [${c.id}]: ${c.name}, ${c.sector}, ${c.employees} employees, ${c.location}.`,
    line("Challenge", ch.id, `${ch.text} ${ch.detail}`),
    line("R&D capacity", `${c.id} rd_capacity`, c.rd_capacity),
    line("Past collaborations", `${c.id} past_collaborations`, c.past_collaborations),
    line("Plans", `${c.id} plans`, c.plans),
    line("Products", `${c.id} products`, c.products),
    `Researcher [${r.id}] (public profile): ${r.title}, ${r.department}, ${r.faculty}.`,
    line("Researcher is open to", `${r.id} open_to`, r.open_to),
  ].join("\n")
}

/** The researcher negotiator's position, with hard limits worked out in code. */
export function researcherCard(pair: Pair, data: Dataset): string {
  const { researcher: r, challenge: ch } = pair
  const { availability, evidence } = availabilityOf(r)
  return [
    `Researcher [${r.id}]: ${r.title}, ${r.department}, ${r.faculty}.`,
    `HARD LIMIT, allowed engagement types: ${allowedEngagements(r).join(", ") || "none"} (from open_to and availability).`,
    `Availability: ${availability}${evidence ? ` [${r.id} ${evidence.field}]: "${evidence.quote}"` : " (no restriction in notes or bio)"}`,
    line("Open to", `${r.id} open_to`, r.open_to),
    line("Background IP, patents to protect", `${r.id} patents`, r.patents),
    line("Notes", `${r.id} notes`, r.notes),
    line("Industry experience", `${r.id} industry_experience`, r.industry_experience),
    ...topPublications(pair, data, 5).map((p) => `Publication [${p.id}]: ${p.title} (${p.year})`),
    line("Challenge", ch.id, `${ch.text} ${ch.detail}`),
  ].join("\n")
}

/** Everything the writer may quote, as JSON records keyed by field name. */
export function evidencePack(pair: Pair, data: Dataset): string {
  const { challenge: ch, company: c, researcher: r } = pair
  const records = [
    { id: ch.id, text: ch.text, detail: ch.detail },
    {
      id: c.id,
      name: c.name,
      sector: c.sector,
      employees: c.employees,
      location: c.location,
      about: c.about,
      products: c.products,
      tech: c.tech,
      rd_capacity: c.rd_capacity,
      past_collaborations: c.past_collaborations,
      plans: c.plans,
    },
    {
      id: r.id,
      title: r.title,
      faculty: r.faculty,
      department: r.department,
      fields: r.fields,
      keywords: r.keywords,
      bio: r.bio,
      industry_experience: r.industry_experience,
      notes: r.notes,
    },
    ...topPublications(pair, data, 5).map((p) => ({ id: p.id, title: p.title, year: p.year, venue: p.venue, keywords: p.keywords, abstract: p.abstract })),
  ]
  return records.map((record) => JSON.stringify(record)).join("\n")
}
