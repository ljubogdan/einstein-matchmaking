# How the agents run concurrently

The rules ask for this explicitly, and "the weight is on genuine use of concurrency". Draft written before the code; replace every `TODO` with what the code actually does.

## Participants and what they react to

| Participant | Instances | Reacts to | Emits |
|---|---|---|---|
| Industry Analyst | TODO | run start | `prenup.challenge.analyzed`, `prenup.nomatch` (not research) |
| Profiler | TODO | profile request | `prenup.profile.ready` |
| Matchmaker | 3-4 | `challenge.analyzed`, `profile.ready`, `arbiter.decided`, `negotiation.no_deal` | `match.proposed`, reservation attempts |
| Arbiter | 1 | `reservation.conflict` | `arbiter.decided` |
| Negotiator | 2 per pair | `match.proposed` | `negotiation.move`, `agreed`, `no_deal` |
| Proposal Writer | TODO | `negotiation.agreed` | `proposal.ready` |
| Critic | 1 | `critic.check` (from the commit gate) | `critic.verdict` |
| Human gate | 1 | `proposal.ready` | `human.approved` |
| Observer | 1 | everything | trace, board, timeline |

## What actually runs at the same time

- Every `runLoop` is fire-and-forget; analysts, profilers, matchmakers and negotiations for different pairs think in parallel.
- A rate limiter (TODO: N in flight) in our InferenceRunner keeps parallel calls inside provider limits.
- TODO: timeline chart from `out/trace.jsonl`, with one row per participant.

## Shared state without races

Matchmakers reserve researchers on the shared Board with a version check: a write only succeeds if the version it read is still current. The loser gets a conflict event; the Arbiter decides by fit and constraints; the losing matchmaker re-matches. No locks, no double-booking.

## Feedback loops (why it is not a pipeline)

1. Reservation conflict -> Arbiter -> losing matchmaker re-matches.
2. Negotiation fails -> the pair returns to its matchmaker.
3. Critic blocks a claim -> rewrite before commit.
4. Profiler flags consulting-only -> negotiators adapt the engagement type.

TODO: one trace excerpt per loop.

## Concurrency, awareness, adaptivity (Mozaik's three pillars)

- **Concurrency:** independent loops, non-blocking fan-out, measured speed-up (TODO numbers).
- **Awareness:** participants react to each other's events (`arbiter.decided`, `critic.verdict`, `participant.joined`) instead of being called.
- **Adaptivity:** behavior changes with runtime state: re-matching after conflicts, terms limited by availability, rewrites after blocks, backoff under rate limits.

## Mozaik features used

TODO, as built: `defineRuntime` with a `RuntimeState` subclass, situation handlers, custom `SemanticEvent`s, `runLoop`, `InterceptionHandler` on `function_call` (the Critic gate), `structuredOutput`, custom `InferenceRunner` (record/replay, rate limiting), observer participant.

## Measured

TODO: sequential vs concurrent wall-clock on the fixed subset (same code, limiter set to 1), with seed, models and date.
