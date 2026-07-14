import { createActor, AnyStateMachine, AnyActorRef, SnapshotFrom } from 'xstate';

/**
 * Snapshot-like shape returned by `runStateMachineToCompletion`. `context` is
 * typed loosely because callers know the specific machine they are running.
 */
export interface StateMachineResult<TContext = Record<string, unknown>> {
  value: unknown;
  status: string;
  context: TContext;
}

/**
 * Runs an xstate machine to completion and returns the final state.
 * The `start` callback receives the actor and should send the initial event(s).
 * For async state machines where actions send events internally, the promise
 * resolves when the machine reaches a final state.
 *
 * `onTransition` is called for every intermediate snapshot. The subscriber below
 * always ran on every transition — the done-check simply threw the rest away, so
 * a blue-green deploy that spends minutes moving through deploy-green → health
 * check → cutover → drain surfaced to the user as a single spinning row. This is
 * the seam those phases escape through; nothing else about the runner changes,
 * and it is optional, so the three other machines that use this runner are
 * unaffected.
 *
 * Note (xstate v5): `subscribe()` does not replay the current snapshot, so the
 * initial `idle` state is never observed — the first callback fires on the
 * transition caused by `start(actor)`. The terminal snapshot does come through,
 * so a listener sees the final phase too.
 */
export function runStateMachineToCompletion<TContext = Record<string, unknown>>(
  machine: AnyStateMachine,
  input: Record<string, unknown>,
  start: (actor: AnyActorRef) => void,
  onTransition?: (state: SnapshotFrom<AnyStateMachine>) => void
): Promise<StateMachineResult<TContext>> {
  return new Promise((resolve) => {
    const actor = createActor(machine, { input } as Parameters<typeof createActor>[1]);

    actor.subscribe((state: SnapshotFrom<AnyStateMachine>) => {
      if (onTransition) {
        try {
          onTransition(state);
        } catch {
          // Progress reporting must never break the deployment it is reporting on.
        }
      }

      if (state.status === 'done') {
        resolve({
          value: state.value,
          status: state.status,
          context: state.context as TContext,
        });
      }
    });

    actor.start();
    start(actor);
  });
}
