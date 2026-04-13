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
 */
export function runStateMachineToCompletion<TContext = Record<string, unknown>>(
  machine: AnyStateMachine,
  input: Record<string, unknown>,
  start: (actor: AnyActorRef) => void
): Promise<StateMachineResult<TContext>> {
  return new Promise((resolve) => {
    const actor = createActor(machine, { input } as Parameters<typeof createActor>[1]);

    actor.subscribe((state: SnapshotFrom<AnyStateMachine>) => {
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
