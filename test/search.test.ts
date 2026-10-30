import { describe, expect, test } from "vitest"
import { Dataset, hasDataset, type Publication } from "../src/tools/dataset"
import { Bm25, PublicationIndex, tokens } from "../src/tools/search"

test("tokens: Cyrillic as Latin, diacritics folded, stop words out, plurals stemmed", () => {
  expect(tokens("Детекција аномалија")).toEqual(tokens("Detekcija anomalija"))
  expect(tokens("Đurđevo Čačak")).toEqual(["djurdjevo", "cacak"])
  expect(tokens("Anomalies in the networks of Modbus")).toEqual(["anomaly", "network", "modbus"])
})

test("BM25: a rare term outweighs a common one; documents without any term are left out", () => {
  const bm25 = new Bm25()
  bm25.add("a", tokens("network traffic network"))
  bm25.add("b", tokens("network modbus"))
  bm25.add("c", tokens("network"))
  bm25.add("d", tokens("soil chemistry"))
  const hits = bm25.search(tokens("modbus network"), 10).map((h) => h.id)
  expect(hits[0]).toBe("b")
  expect(hits.sort()).toEqual(["a", "b", "c"])
})

function fakeData(publications: Partial<Publication>[]): Dataset {
  const data = new Dataset()
  for (const id of ["R0001", "R0002", "R0003"]) data.researchers.set(id, { id, name: "Ana Petrović" } as never)
  for (const p of publications) data.publications.set(p.id!, { title: "", abstract: "", keywords: [], year: 2024, venue: "", type: "", authors: [], ...p } as Publication)
  return data
}

test("shortlist joins on researcher_id, not names, and ignores authors without one", () => {
  const author = (researcher_id: string | null) => ({ name: "Ana Petrović", researcher_id, affiliation: "" })
  const index = new PublicationIndex(
    fakeData([
      { id: "P1", title: "Modbus anomaly detection", authors: [author("R0001"), author(null)] },
      { id: "P2", title: "Modbus traffic", authors: [author("R0002")] },
      { id: "P3", title: "Soil chemistry", authors: [author("R0003")] },
    ]),
  )
  const shortlist = index.shortlist("modbus anomaly", 5)
  expect(shortlist.map((c) => c.researcherId)).toEqual(["R0001", "R0002"]) // same name, three ids: only the authors who match
  expect(shortlist[0].publications.map((h) => h.id)).toEqual(["P1"])
})

test("shortlist counts only a researcher's best publications, so volume alone doesn't win", () => {
  const by = (id: string) => [{ name: "", researcher_id: id, affiliation: "" }]
  const many = Array.from({ length: 6 }, (_, i) => ({ id: `M${i}`, title: "modbus", abstract: "filler words here", authors: by("R0001") }))
  const index = new PublicationIndex(fakeData([...many, { id: "S1", title: "modbus anomaly detection", authors: by("R0002") }]))
  const [first] = index.shortlist("modbus anomaly detection", 5, { perResearcher: 1 })
  expect(first.researcherId).toBe("R0002")
  expect(index.shortlist("modbus", 5, { perResearcher: 3 })[0].publications).toHaveLength(3)
})

// Real ids from the pinned dataset; skipped on a clone without data/einstein.
describe.skipIf(!hasDataset())("real data", () => {
  test("the Modbus anomaly-detection author (SYN-PUB-10523) is shortlisted for academic terms", () => {
    const index = new PublicationIndex(Dataset.load())
    const shortlist = index.shortlist("unsupervised anomaly detection industrial control systems Modbus network traffic", 5)
    expect(shortlist.map((c) => c.researcherId)).toContain("R1015")
    expect(shortlist.find((c) => c.researcherId === "R1015")!.publications.map((h) => h.id)).toContain("SYN-PUB-10523")
  })
})
