# How the agents run concurrently

The rules ask for this explicitly, and "the weight is on genuine use of concurrency". This page describes the code as it runs today.

## Participants and what they react to

| Participant | Instances | Reacts to | Emits |
|---|---|---|---|
| Matchmaker | 3, each owning a slice of the challenges | `challenge.analyzed`, `profile.ready`, `arbiter.decided`, `negotiation.no_deal` | `challenge.submitted`, `shortlist.ready`, `reservation.conflict`, `match.proposed`, `rematch`, `nomatch` |
| Industry Analyst | one agent per challenge (cheap model) | `challenge.submitted` | `challenge.analyzed` |
| Profiler | one agent per shortlisted researcher per challenge, plus one per rewrite (cheap model) | `shortlist.ready`, `critic.done` | `critic.check`, `profile.ready` |
| Arbiter | one agent per conflict (strong model) | `reservation.conflict`, `profile.ready` | `pair.cancelled`, `arbiter.decided` |
| Negotiator | 2 per pair: company side, researcher side (strong model) | `match.proposed`, `negotiation.move` | `negotiation.move`, `negotiation.agreed`, `negotiation.no_deal` |
| Proposal Writer | one per pair (strong model) | `negotiation.agreed`, `critic.done`, `pair.cancelled` | `critic.check`, `writer.rewrote`, `claim.dropped`, `proposal.ready` |
| Critic | 1 (code checks), plus one support-check agent per check request (cheap model) | `critic.check` | `critic.verdict` per claim, `critic.done` |
| Observer, Reporter | 1 each | everything | `out/trace.jsonl`, `out/nomatch.md`, `out/traps.md` |

In the demo run that is 3 matchmakers, 4 analysts, 15 profilers plus 14 profiler rewrites, 34 support checks, 1 arbiter, 6 negotiators and 3 writers.

## What actually runs at the same time

- Every `runLoop` is fire-and-forget; nothing awaits a model. All matchmakers submit their challenges at once, so the analysts think in parallel, then every challenge's five profilers, then the negotiations of different pairs.
- A fresh agent per task means memory never crosses challenges, researchers or sides, and each answer maps back to its task.
- One runner wraps every model call: at most 8 calls in flight, retries with backoff on 408/429/5xx (the hackathon gateway does answer 429 "too many requests at once"), and record/replay.
- Cached results arrive on the next tick, like a model answer, so a cached run keeps the same concurrent shape.
- `--paced` replays each recorded answer after the latency measured when it was recorded (waiting for a slot and retries included), so a replay keeps the live run's timing; the committed `out/trace.jsonl` and the board's timeline come from it. The recording run's own trace is `out/trace-recording.jsonl`.

## Shared state without races

The Board (a Mozaik `RuntimeState`) holds researcher reservations as `{ challengeId, version }`.

1. When a matchmaker makes its shortlist, it reads each candidate's reservation version.
2. When the profile cards are in, it writes with the version it read. If another matchmaker reserved that researcher in the meantime, the write fails: no overwrite, no lock.
3. The failure becomes `prenup.reservation.conflict`. The Arbiter reads both challenges' cards and each side's best alternative and picks a winner, citing ids. Code then moves the reservation (version-checked again) and cancels the losing pair if it had already started; its agents drop whatever is still in flight.
4. The losing matchmaker hears `prenup.arbiter.decided` and re-matches from its own cards.

The Arbiter's prompt lists the two challenges in id order, never as holder and requester, so its recorded answer replays whichever matchmaker happens to win the race.

## Feedback loops (why it is not a pipeline)

1. **Reservation conflict -> Arbiter -> the losing matchmaker re-matches.** Built; in the demo run (`out/trace.jsonl`):

   ```json
   {"type":"prenup.match.proposed","producer":"matchmaker-1","payload":{"pairId":"C001-CH1__R1015", "...": "..."}}
   {"type":"prenup.reservation.conflict","producer":"matchmaker-2","payload":{"researcherId":"R1015","challengeId":"C032-CH1","holder":"C001-CH1","seenVersion":0,"version":1}}
   {"type":"prenup.pair.cancelled","producer":"arbiter:R1015","payload":{"pairId":"C001-CH1__R1015","reason":"the Arbiter gave R1015 to C032-CH1"}}
   {"type":"prenup.arbiter.decided","producer":"arbiter:R1015","payload":{"researcherId":"R1015","winner":"C032-CH1","loser":"C001-CH1", "...": "..."}}
   {"type":"prenup.rematch","producer":"matchmaker-1","payload":{"challengeId":"C001-CH1","from":"R1015", "...": "..."}}
   {"type":"prenup.match.proposed","producer":"matchmaker-1","payload":{"pairId":"C001-CH1__R1008", "...": "..."}}
   ```

   Matchmaker-1 reserved R1015 first and its negotiation had started; matchmaker-2's write then failed the version check. The Arbiter gave R1015 to C032-CH1, so the C001-CH1 negotiation was cancelled mid-way and matchmaker-1 re-matched to R1008 by itself. The Arbiter is never told which side holds the researcher, so who writes first can't affect its decision.

2. **Negotiation ends in no deal -> the challenge goes back to its matchmaker**, which tries its next card (at most 2 negotiations per challenge, then a no-match). Built; no negotiation in the demo run ended without a deal, so it is shown in `test/matchmaker.test.ts`.
3. **The Critic stops a claim -> it goes back to its author once.** Built: the writer gets its stopped claims back in the same conversation, a stopped profile claim goes to a fresh Profiler agent, each with the reason and the Critic's suggested sentence. The fix is checked again; what still fails is dropped (`prenup.claim.dropped`) and listed on the page. In the demo run all 3 writers and 14 of 15 profile cards sent claims back once.
4. **A profile is retired or consulting-only -> negotiators can only offer what's allowed.** Built: the researcher side's allowed engagement types come from code (`open_to` and availability), and a move outside them becomes a walk-away.

## Concurrency, awareness, adaptivity (Mozaik's three pillars)

- **Concurrency:** independent loops per task, non-blocking fan-out, a shared board with version-checked writes.
- **Awareness:** participants react to each other's events (`arbiter.decided`, `critic.done`, `pair.cancelled`, `negotiation.no_deal`) instead of being called.
- **Adaptivity:** behavior follows runtime state: re-matching after conflicts and no-deals, rewriting claims the Critic stopped, terms limited by availability, cancelled pairs going quiet, backoff under rate limits.

## Mozaik features used

`defineRuntime` with a `RuntimeState` subclass (the Board); `createAgent` and `createHuman` participants with situation handlers (`SituationSpecification`); custom `SemanticEvent`s; fire-and-forget `runLoop`; `structuredOutput` from zod schemas; a custom `InferenceRunner` (record/replay, calls in flight, retries); an observer participant writing the trace. The Critic gate is an event round trip (`critic.check` -> `critic.done`), not an `InterceptionHandler`.

## Measured

Concurrent vs one call at a time, on 30 Oct: the demo set (4 challenges) run twice live with `--fresh`, same code and models, up to 8 model calls at once vs `--in-flight=1`. **170.7 s vs 380.3 s, 2.2x faster**, 89 model calls each. The concurrent run hit the gateway's rate limit 11 times and retried. The answers were fresh, so the runs took slightly different paths: the concurrent one wrote more (42k vs 26k strong-model output tokens) and still finished first. Raw data: [`out/eval/concurrency.json`](out/eval/concurrency.json), with both runs' logs and traces next to it.

The demo set replayed at recorded latency, drawn: [`out/eval/timeline.svg`](out/eval/timeline.svg) (68 calls in 75 s, up to 15 open at once).

Without the version check, the same matchmaker code would double-book 104 researchers across 264 of the 489 challenges; with it, none ([`out/eval/arbiter-*.json`](out/eval/), a code-only simulation with stand-ins for the model agents).
