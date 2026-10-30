import { defineRuntime, RuntimeState, SituationSpecification, type SituationContext } from "@mozaik-ai/core"
import type { NegotiationMove } from "./schema/termsheet"

/** Shared state every participant sees. Reservations land here next. */
export class Board extends RuntimeState {
  /** pairId -> moves in order; move n is round n. */
  readonly negotiations = new Map<string, NegotiationMove[]>()

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
