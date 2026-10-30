import { defineRuntime, RuntimeState, SituationSpecification, type SituationContext } from "@mozaik-ai/core"
import type { NegotiationMove } from "./schema/termsheet"

export type Reservation = { challengeId: string; version: number }

/** Shared state every participant sees. */
export class Board extends RuntimeState {
  /** researcherId -> who holds them. Version 0 = never reserved. */
  readonly reservations = new Map<string, Reservation>()
  /** pairId -> moves in order; move n is round n. */
  readonly negotiations = new Map<string, NegotiationMove[]>()

  /** What a matchmaker reads before reserving: the current holder and version. */
  reservation(researcherId: string): Reservation | undefined {
    return this.reservations.get(researcherId)
  }

  /**
   * Version-checked write: succeeds only if nobody reserved the researcher since the caller read `expectedVersion`.
   * A false means the caller lost the race; it emits `prenup.reservation.conflict` for the Arbiter, never overwrites.
   */
  reserve(researcherId: string, challengeId: string, expectedVersion: number): boolean {
    const current = this.reservations.get(researcherId)
    if ((current?.version ?? 0) !== expectedVersion) return false
    this.reservations.set(researcherId, { challengeId, version: expectedVersion + 1 })
    return true
  }

  addMove(move: NegotiationMove): void {
    this.negotiations.set(move.pairId, [...(this.negotiations.get(move.pairId) ?? []), move])
  }

  move(pairId: string, round: number): NegotiationMove | undefined {
    return this.negotiations.get(pairId)?.[round - 1]
  }
}

// Not package exports: defineRuntime is bound to our Board once, here. initializeRuntime throws if called twice.
export const { initializeRuntime, resolveRuntime, join, leave, sendMessage, sendEvent, runLoop } = defineRuntime<Board>()

class Matches extends SituationSpecification {
  constructor(private readonly test: (ctx: SituationContext) => boolean) {
    super()
  }
  isSatisfiedBy(ctx: SituationContext): boolean {
    return this.test(ctx)
  }
}

/** Events of one type produced by another participant. */
export const on = (type: string): SituationSpecification =>
  new Matches(({ event, participant }) => event.type === type && event.producerId !== participant.getId())

/** Events of one type produced by this participant itself, e.g. its own loop's `model.answer`. */
export const own = (type: string): SituationSpecification =>
  new Matches(({ event, participant }) => event.type === type && event.producerId === participant.getId())

/** Every event, built-in ones included. For observers only. */
export const anyEvent = (): SituationSpecification => new Matches(() => true)
