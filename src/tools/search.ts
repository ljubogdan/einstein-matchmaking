import type { Dataset, Publication } from "./dataset"
import { normalize } from "./normalize"

// Words that carry no topic in titles and abstracts (English; Serbian ones are rare in publications).
const STOP = new Set(
  "a an and are as at be by can for from has have in into is it its of on or our that the their this to using was we were which with within without based via new study approach method methods results paper"
    .split(" "),
)

/** Search tokens: normalize() (Cyrillic as Latin), diacritics folded, stop words out, plural -s stripped. */
export function tokens(text: string): string[] {
  return normalize(text)
    .replace(/đ/g, "dj")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem)
}

// Light stemming, so "networks" finds "network" and "anomalies" finds "anomaly". Nothing smarter: reproducible beats clever.
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`
  if (w.length > 3 && w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1)
  return w
}

export type Hit = { id: string; score: number }

/** Okapi BM25 over short documents, in memory. */
export class Bm25 {
  private readonly docs: { id: string; tf: Map<string, number>; length: number }[] = []
  private readonly df = new Map<string, number>()
  private totalLength = 0

  constructor(
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {}

  add(id: string, words: string[]): void {
    const tf = new Map<string, number>()
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1)
    for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1)
    this.docs.push({ id, tf, length: words.length })
    this.totalLength += words.length
  }

  get size(): number {
    return this.docs.length
  }

  search(query: string[], k: number): Hit[] {
    const n = this.docs.length
    const avg = this.totalLength / Math.max(n, 1)
    const terms = [...new Set(query)].filter((w) => this.df.has(w))
    const idf = new Map(terms.map((w) => [w, Math.log(1 + (n - this.df.get(w)! + 0.5) / (this.df.get(w)! + 0.5))]))
    const hits: Hit[] = []
    for (const doc of this.docs) {
      let score = 0
      for (const w of terms) {
        const f = doc.tf.get(w)
        if (f) score += (idf.get(w)! * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * doc.length) / avg))
      }
      if (score > 0) hits.push({ id: doc.id, score })
    }
    return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k)
  }
}

/** A shortlisted researcher: relevance to one query, with the publications that earned it. */
export type Candidate = { researcherId: string; score: number; publications: Hit[] }

/** BM25 over every publication's title, keywords and abstract; title and keywords count twice. */
export class PublicationIndex {
  readonly bm25 = new Bm25()

  constructor(private readonly data: Dataset) {
    for (const p of data.publications.values()) this.bm25.add(p.id, publicationTokens(p))
  }

  search(query: string, k = 20): Hit[] {
    return this.bm25.search(tokens(query), k)
  }

  /**
   * Researchers behind the best-matching publications, joined on author researcher_id (never names: same-name trap).
   * Relevance = sum of the researcher's `perResearcher` best publication scores, so a long publication list alone doesn't win.
   */
  shortlist(query: string, k = 5, { pool = 300, perResearcher = 3 } = {}): Candidate[] {
    const byResearcher = new Map<string, Hit[]>()
    for (const hit of this.search(query, pool)) {
      for (const author of this.data.publications.get(hit.id)!.authors) {
        if (!author.researcher_id || !this.data.researchers.has(author.researcher_id)) continue
        const hits = byResearcher.get(author.researcher_id) ?? []
        if (!hits.some((h) => h.id === hit.id)) byResearcher.set(author.researcher_id, [...hits, hit])
      }
    }
    return [...byResearcher]
      .map(([researcherId, hits]) => {
        const publications = hits.slice(0, perResearcher)
        return { researcherId, score: publications.reduce((sum, h) => sum + h.score, 0), publications }
      })
      .sort((a, b) => b.score - a.score || a.researcherId.localeCompare(b.researcherId))
      .slice(0, k)
  }
}

function publicationTokens(p: Publication): string[] {
  const strong = tokens(`${p.title} ${p.keywords.join(" ")}`)
  return [...strong, ...strong, ...tokens(p.abstract ?? "")]
}
