import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type Researcher = {
  id: string
  name: string
  title: string
  institution: string
  faculty: string
  department: string
  fields: string[]
  keywords: string[]
  bio: string
  publications: string[]
  projects: string[]
  patents: string[]
  open_to: string[]
  industry_experience: string
  notes: string
  language: string
}
export type Challenge = { id: string; text: string; detail: string }
export type Company = {
  id: string
  name: string
  sector: string
  employees: number
  founded: number
  location: string
  about: string
  products: string[]
  tech: string[]
  challenges: Challenge[]
  plans: string
  rd_capacity: string
  past_collaborations: string
  language: string
}
export type Publication = {
  id: string
  title: string
  abstract: string
  year: number
  venue: string
  type: string
  keywords: string[]
  authors: { name: string; researcher_id: string | null; affiliation: string }[]
}
export type Project = { id: string; title: string; summary: string; participants: { researcher_id: string | null; role: string }[] }
export type Patent = { id: string; title: string; year: number; status: string; abstract: string }

export const DATA_DIR = process.env.PRENUP_DATA ?? "data/einstein/data"
export const hasDataset = (dir = DATA_DIR): boolean => existsSync(join(dir, "researchers.json"))

/** The EINSTEIN dataset in memory, indexed by id. Everything joins on ids, never on names. */
export class Dataset {
  readonly researchers = new Map<string, Researcher>()
  readonly companies = new Map<string, Company>()
  readonly challenges = new Map<string, Challenge>()
  readonly challengeCompany = new Map<string, string>()
  readonly publications = new Map<string, Publication>()
  readonly projects = new Map<string, Project>()
  readonly patents = new Map<string, Patent>()

  static load(dir = DATA_DIR): Dataset {
    const data = new Dataset()
    const json = (file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"))
    for (const r of json("researchers.json").researchers as Researcher[]) data.researchers.set(r.id, r)
    for (const c of json("companies.json").companies as Company[]) {
      data.companies.set(c.id, c)
      for (const ch of c.challenges) {
        data.challenges.set(ch.id, ch)
        data.challengeCompany.set(ch.id, c.id)
      }
    }
    for (const p of json("projects.json").projects as Project[]) data.projects.set(p.id, p)
    for (const p of json("patents.json").patents as Patent[]) data.patents.set(p.id, p)
    for (const line of readFileSync(join(dir, "publications.jsonl"), "utf8").split("\n")) {
      if (line.trim()) {
        const p = JSON.parse(line) as Publication
        data.publications.set(p.id, p)
      }
    }
    return data
  }

  /** Any record by its id: researcher, company, challenge, publication, project or patent. */
  record(id: string): Record<string, unknown> | undefined {
    return (this.researchers.get(id) ??
      this.companies.get(id) ??
      this.challenges.get(id) ??
      this.publications.get(id) ??
      this.projects.get(id) ??
      this.patents.get(id)) as Record<string, unknown> | undefined
  }
}

/** A record's field as plain text, for quoting: strings as is, lists comma-separated (that's how models copy them). */
export function fieldText(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ")
  return undefined
}
