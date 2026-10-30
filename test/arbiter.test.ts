import { createHuman, ModelMessageItem, SemanticEvent, type InferenceInput, type InferenceRunner } from "@mozaik-ai/core"
import { describe, expect, test } from "vitest"
import { createArbiter, type Decision } from "../src/agents/arbiter"
import { RecordingRunner } from "../src/llm/runner"
import { anyEvent, Board, initializeRuntime, join, sendEvent } from "../src/runtime"
import type { ProfileCard } from "../src/schema/profile"
import { Dataset, hasDataset } from "../src/tools/dataset"

// The model is faked behind the real runner; what's tested is the prompt it gets and the board writes after its answer.
describe.skipIf(!hasDataset())("arbiter: decides a conflict, then code moves the reservation", () => {
  const data = Dataset.load()
  const board = new Board()
  const prompts: string[] = []
  let reply = ""
  const inner: InferenceRunner = {
    run: () => Promise.reject(new Error("the runner should stream")),
    stream: async function* (input: InferenceInput) {
      prompts.push(JSON.stringify(input.context.getItems().at(-1)))
      yield SemanticEvent.create("inference.output", input.model, { items: [ModelMessageItem.rehydrate({ text: reply })], tokenUsage: undefined, rowResponse: null })
    },
  }
  initializeRuntime({ state: board, inferenceRunnerConfig: { runner: new RecordingRunner({ mode: "fresh", dir: "out/tmp/fixtures-arbiter-test", inner }) } })
  const events: { type: string; payload: unknown }[] = []
  let decided: (d: Decision) => void = () => {}
  const tester = createHuman({
    name: "tester",
    capabilities: [],
    handlers: [
      {
        specification: anyEvent(),
        processor: {
          apply: ({ event }) => {
            events.push({ type: event.type, payload: event.payload })
            if (event.type === "prenup.arbiter.decided") decided(event.payload as Decision)
          },
        },
      },
    ],
  })
  join(createArbiter(data, board))
  join(tester)
  const send = (type: string, payload: unknown) => sendEvent(SemanticEvent.create(type, tester.getId(), payload), tester.getId())
  const card = (challengeId: string, researcherId: string, rank: number): ProfileCard => ({
    challengeId, researcherId, rank, publications: [], availability: "available", allowedEngagements: ["joint_project"], flags: [], expertise: [], blocked: 0, fit: "strong", fitReason: `fits ${challengeId}`, cached: true,
  })
  for (const challengeId of ["C001-CH1", "C032-CH1"]) for (const [i, r] of ["R1015", "R1008"].entries()) send("prenup.profile.ready", card(challengeId, r, i + 1))
  const conflict = (challengeId: string, holder: string) =>
    new Promise<Decision>((resolve) => {
      decided = resolve
      send("prenup.reservation.conflict", { researcherId: "R1015", challengeId, holder, seenVersion: 0, version: board.reservation("R1015")!.version })
    })

  test("the requester wins: the reservation moves (version-checked) and the holder's pair is cancelled before the decision", async () => {
    board.reserve("R1015", "C001-CH1", 0)
    reply = JSON.stringify({ winner: "C032-CH1", reason: "Both fit [R1015]; C001-CH1 has [R1008].", citations: ["R1015", "R1008"], evidence: [] })
    const decision = await conflict("C032-CH1", "C001-CH1")
    expect(decision).toMatchObject({ researcherId: "R1015", winner: "C032-CH1", loser: "C001-CH1", holder: "C001-CH1", version: 2 })
    expect(board.reservation("R1015")).toEqual({ challengeId: "C032-CH1", version: 2 })
    expect(board.cancelled.has("C001-CH1__R1015")).toBe(true)
    const types = events.map((e) => e.type)
    expect(types.indexOf("prenup.pair.cancelled")).toBeLessThan(types.indexOf("prenup.arbiter.decided"))
    expect(prompts[0]).toContain("Best alternative: [R1008]")
    expect(prompts[0].indexOf("[C001-CH1]")).toBeLessThan(prompts[0].indexOf("[C032-CH1]"))
  })

  test("the prompt doesn't depend on who reserved first; an invalid winner leaves the holder in place", async () => {
    reply = JSON.stringify({ winner: "C999-CH9", reason: "", citations: [], evidence: [] })
    const decision = await conflict("C001-CH1", "C032-CH1") // roles swapped
    expect(prompts[1]).toBe(prompts[0])
    expect(decision).toMatchObject({ winner: "C032-CH1", loser: "C001-CH1", holder: "C032-CH1", version: 2 })
    expect(board.cancelled.has("C032-CH1__R1015")).toBe(false)
  })

  test("the reasoning is checked before it's published: a citation whose words aren't in the brief goes, a stray number is reported", async () => {
    reply = JSON.stringify({
      winner: "C032-CH1",
      reason: "The card fits [C001-CH1]. It was deployed at 7 sites [R1008].",
      citations: ["C001-CH1", "R1008"],
      evidence: [{ citation: "C001-CH1", quote: "fits C001-CH1" }, { citation: "R1008", quote: "deployed at seven utilities" }],
    })
    const decision = await conflict("C001-CH1", "C032-CH1")
    expect(decision.reason).toContain("[R1008]") // kept word for word: the check reports, it doesn't cut
    expect(decision.check).toMatchObject({ cited: 2, backed: 1, notBacked: ["R1008"], numbersNotInBrief: ["7"] }) // R1008's words aren't in the brief
    expect(decision.evidence.map((e) => e.citation)).toEqual(["C001-CH1"]) // the citation check's answer here is unreadable, so nothing more goes
  })
})

test("a quote counts when it's in the part of the brief about the id it's cited for", async () => {
  const { quotedInBrief } = await import("../src/agents/arbiter")
  const brief = "Researcher [R1015]: Associate Professor.\n\nChallenge [C001-CH1] (company [C001]): Modbus.\n  Card for [R1015] on this challenge: fit strong.\n  Taking the alternative loses 8%.\nChallenge [C032-CH1] (company [C032]): edge.\n  Taking the alternative loses 14%."
  const evidence = [
    { citation: "C001-CH1", quote: "Taking the alternative loses 8%." },
    { citation: "C032-CH1", quote: "Taking the alternative loses 8%." }, // in C001-CH1's part, not C032-CH1's
    { citation: "R1015", quote: "fit strong" },
  ]
  expect(quotedInBrief(brief, evidence)).toEqual({ kept: [evidence[0], evidence[2]], notInBrief: ["C032-CH1"] })
})
