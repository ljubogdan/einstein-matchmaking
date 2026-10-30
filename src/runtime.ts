import { defineRuntime, RuntimeState, SituationSpecification, type SituationContext } from "@mozaik-ai/core"

/** Shared state every participant sees. Reservations and loop caps land here from M1. */
export class Board extends RuntimeState {}

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

/** Every event, built-in ones included. For observers only. */
export const anyEvent = (): SituationSpecification => new Matches(() => true)
