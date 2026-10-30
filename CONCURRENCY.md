# How the agents run concurrently

The rules ask for this explicitly, and "the weight is on genuine use of concurrency". This page describes the code as it runs today.

## Participants and what they react to

| Participant | Instances | Reacts to | Emits |
|---|---|---|---|
| Matchmaker | 3, each owning a slice of the challenges | `challenge.analyzed`, `profile.ready`, `arbiter.decided`, `negotiation.no_deal` | `challenge.submitted`, `shortlist.ready`, `reservation.conflict`, `match.proposed`, `rematch`, `nomatch` |
| Industry Analyst | one agent per challenge (cheap model) | `challenge.submitted` | `challenge.analyzed` |
| Profiler | one agent per shortlisted researcher per challenge (cheap model) | `shortlist.ready`, `critic.done` | `critic.check`, `profile.ready` |
| Arbiter | one agent per conflict (strong model) | `reservation.conflict`, `profile.ready` | `pair.cancelled`, `arbiter.decided` |
| Negotiator | 2 per pair: company side, researcher side (strong model) | `match.proposed`, `negotiation.move` | `negotiation.move`, `negotiation.agreed`, `negotiation.no_deal` |
| Proposal Writer | one per pair (strong model) | `negotiation.agreed`, `critic.done`, `pair.cancelled` | `critic.check`, `proposal.ready` |
| Critic | 1, code only | `critic.check` | `critic.verdict` per claim, `critic.done` |
| Observer, Reporter | 1 each | everything | `out/trace.jsonl`, `out/nomatch.md`, `out/traps.md` |

In the demo run that is 3 matchmakers, 4 analysts, 15 profilers, 1 arbiter, 6 negotiators and 3 writers.

## What actually runs at the same time

- Every `runLoop` is fire-and-forget; nothing awaits a model. All matchmakers submit their challenges at once, so the analysts think in parallel, then every challenge's five profilers, then the negotiations of different pairs.
- A fresh agent per task means memory never crosses challenges, researchers or sides, and each answer maps back to its task.
- One runner wraps every model call: at most 8 calls in flight, retries with backoff on 408/429/5xx (the hackathon gateway does answer 429 "too many requests at once"), and record/replay.
- Cached results arrive on the next tick, like a model answer, so a cached run keeps the same concurrent shape.

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
   {"type":"prenup.reservation.conflict","producer":"matchmaker-2","payload":{"researcherId":"R1015","challengeId":"C032-CH1","holder":"C001-CH1","seenVersion":0,"version":1}}
   {"type":"prenup.arbiter.decided","producer":"arbiter:R1015","payload":{"researcherId":"R1015","winner":"C001-CH1","loser":"C032-CH1", "...": "..."}}
   {"type":"prenup.rematch","producer":"matchmaker-2","payload":{"challengeId":"C032-CH1","from":"R1015", "...": "..."}}
   {"type":"prenup.match.proposed","producer":"matchmaker-2","payload":{"pairId":"C032-CH1__R1008", "...": "..."}}
   ```

2. **Negotiation ends in no deal -> the challenge goes back to its matchmaker**, which tries its next card (at most 2 negotiations per challenge, then a no-match). Built; no negotiation in the demo run ended without a deal, so it is shown in `test/matchmaker.test.ts`.
3. **The Critic blocks a claim.** Built for blocking: blocked profile claims never reach the matchmakers, blocked proposal claims are listed on the page. The rewrite before commit is not built yet.
4. **A profile is retired or consulting-only -> negotiators can only offer what's allowed.** Built: the researcher side's allowed engagement types come from code (`open_to` and availability), and a move outside them becomes a walk-away.

## Concurrency, awareness, adaptivity (Mozaik's three pillars)

- **Concurrency:** independent loops per task, non-blocking fan-out, a shared board with version-checked writes.
- **Awareness:** participants react to each other's events (`arbiter.decided`, `critic.done`, `pair.cancelled`, `negotiation.no_deal`) instead of being called.
- **Adaptivity:** behavior follows runtime state: re-matching after conflicts and no-deals, terms limited by availability, cancelled pairs going quiet, backoff under rate limits.

## Mozaik features used

`defineRuntime` with a `RuntimeState` subclass (the Board); `createAgent` and `createHuman` participants with situation handlers (`SituationSpecification`); custom `SemanticEvent`s; fire-and-forget `runLoop`; `structuredOutput` from zod schemas; a custom `InferenceRunner` (record/replay, calls in flight, retries); an observer participant writing the trace. The Critic gate is an event round trip (`critic.check` -> `critic.done`), not an `InterceptionHandler`.

## Measured

Not yet: sequential vs concurrent wall-clock on a fixed subset (same code, one call in flight), with the seed, models and date. It comes with the final submission.
