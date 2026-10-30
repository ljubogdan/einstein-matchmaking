import type { ProfileCard } from "../schema/profile"
import type { Challenge, Company, Dataset, Publication, Researcher } from "./dataset"
import { allowedEngagements, availabilityOf } from "./profile"

export type Pair = { pairId: string; challenge: Challenge; company: Company; researcher: Researcher }

export function makePair(data: Dataset, challengeId: string, researcherId: string): Pair {
  const challenge = data.challenges.get(challengeId)
  const company = data.companies.get(data.challengeCompany.get(challengeId) ?? "")
  const researcher = data.researchers.get(researcherId)
  if (!challenge || !company || !researcher) throw new Error(`unknown pair ${challengeId} / ${researcherId}`)
  return { pairId: `${challengeId}__${researcherId}`, challenge, company, researcher }
}

/** The search hits the Profiler read for this pair: the negotiators' and writer's publication evidence. */
export function profileHits(profile: ProfileCard, data: Dataset): Publication[] {
  return profile.publications.map((id) => data.publications.get(id)).filter((p): p is Publication => p !== undefined)
}

// Titles of people whose own thesis depends on publishing (English, Latin and Cyrillic Serbian).
const EARLY_CAREER = /phd student|teaching assistant|research assistant|doktorskih|докторских|asistent|асистент/i

/** The researcher's publication record in one line, from their authored publications. */
function publishing(r: Researcher, data: Dataset): string {
  const years = r.publications
    .map((id) => data.publications.get(id))
    .filter((p): p is Publication => p !== undefined && p.authors.some((a) => a.researcher_id === r.id))
    .map((p) => p.year)
  const record = years.length ? `${years.length} authored publications, latest ${Math.max(...years)}` : "no authored publications"
  return `${record}${EARLY_CAREER.test(r.title) ? `; as a ${r.title}, their thesis depends on publishing` : ""}`
}

const line = (label: string, ref: string, value: string | string[]) =>
  `${label} [${ref}]: ${Array.isArray(value) ? value.join("; ") || "none" : value || "none"}`

/** What the Profiler found, as both sides may read it: fit for this challenge, claims that passed the Critic, the search hits. */
function findings(profile: ProfileCard, data: Dataset): string[] {
  return [
    `Fit for this challenge (Profiler): ${profile.fit}. ${profile.fitReason}`,
    ...profile.expertise.map((c) => `Expertise [${[...new Set(c.sources.map((s) => s.id))].join(", ")}]: ${c.text}`),
    ...profileHits(profile, data).map((p) => `Publication [${p.id}]: ${p.title} (${p.year})`),
  ]
}

/** The company negotiator's position: its own record, plus the researcher's public profile and the Profiler's findings. */
export function companyCard(pair: Pair, profile: ProfileCard, data: Dataset): string {
  const { company: c, challenge: ch, researcher: r } = pair
  return [
    `Company [${c.id}]: ${c.name}, ${c.sector}, ${c.employees} employees, ${c.location}. Size your contributions to a firm of this size.`,
    line("Challenge", ch.id, `${ch.text} ${ch.detail}`),
    line("R&D capacity, what you can contribute in kind", `${c.id} rd_capacity`, c.rd_capacity),
    line("Past collaborations", `${c.id} past_collaborations`, c.past_collaborations),
    line("Plans", `${c.id} plans`, c.plans),
    line("Products, the field you may want exclusivity in", `${c.id} products`, c.products),
    line("Technology", `${c.id} tech`, c.tech),
    `Researcher [${r.id}] (public profile): ${r.title}, ${r.department}, ${r.faculty}.`,
    line("Researcher is open to", `${r.id} open_to`, r.open_to),
    ...findings(profile, data),
  ].join("\n")
}

/** The researcher negotiator's position, with hard limits worked out in code and expertise from the Profiler's card. */
export function researcherCard(pair: Pair, profile: ProfileCard, data: Dataset): string {
  const { researcher: r, challenge: ch } = pair
  const { availability, evidence } = availabilityOf(r)
  const patents = r.patents.map((id) => `${id} "${data.patents.get(id)?.title ?? "?"}" (${data.patents.get(id)?.status ?? "?"})`)
  const projects = r.projects.map((id) => `${id} "${data.projects.get(id)?.title ?? "?"}"`)
  const notesTrusted = !profile.flags.some((f) => f.kind === "identity_conflict")
  return [
    `Researcher [${r.id}]: ${r.title}, ${r.department}, ${r.faculty}.`,
    `HARD LIMIT, allowed engagement types: ${allowedEngagements(r).join(", ") || "none"} (from open_to and availability).`,
    `Availability: ${availability}${evidence ? ` [${r.id} ${evidence.field}]: "${evidence.quote}"` : " (no restriction in notes or bio)"}`,
    line("Open to", `${r.id} open_to`, r.open_to),
    line("Background IP, patents to protect", `${r.id} patents`, patents),
    line("Earlier projects, background know-how", `${r.id} projects`, projects),
    line("Publishing, why publication rights matter", `${r.id} publications`, publishing(r, data)),
    notesTrusted ? line("Notes, your own preferences", `${r.id} notes`, r.notes) : `Notes [${r.id} notes]: not used, they are about another person`,
    line("Industry experience", `${r.id} industry_experience`, r.industry_experience),
    ...profile.flags.filter((f) => f.kind !== "identity_conflict").map((f) => `Flag (${f.kind}): ${f.detail}`),
    ...findings(profile, data),
    line("Challenge", ch.id, `${ch.text} ${ch.detail}`),
  ].join("\n")
}

/** Everything the writer may quote, as JSON records keyed by field name: the pair, the Profiler's hits, the patents. */
export function evidencePack(pair: Pair, profile: ProfileCard, data: Dataset): string {
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
    ...profileHits(profile, data).map((p) => ({ id: p.id, title: p.title, year: p.year, venue: p.venue, keywords: p.keywords, abstract: p.abstract })),
    ...r.patents.flatMap((id) => data.patents.get(id) ?? []),
  ]
  return records.map((record) => JSON.stringify(record)).join("\n")
}

/** The Profiler's claims that passed the Critic, for the writer to build on (quotes already verified). */
export function checkedFindings(profile: ProfileCard): string {
  return profile.expertise.map((c) => JSON.stringify({ subject: c.subject, text: c.text, sources: c.sources })).join("\n") || "none"
}
