import { createActor, AnyStateMachine, SnapshotFrom } from 'xstate';

/**
 * Runs an xstate machine to completion and returns the final state.
 * The `start` callback receives the actor and should send the initial event(s).
 * For async state machines where actions send events internally, the promise
 * resolves when the machine reaches a final state.
 */
export function runStateMachineToCompletion<TMachine extends AnyStateMachine>(
  machine: TMachine,
  input: Record<string, unknown>,
  start: (actor: ReturnType<typeof createActor<TMachine>>) => void
): Promise<SnapshotFrom<TMachine>> {
  return new Promise((resolve) => {
    const actor = createActor(machine, { input });

    actor.subscribe((state) => {
      if (state.status === 'done') {
        resolve(state as SnapshotFrom<TMachine>);
      }
    });

    actor.start();
    start(actor);
  });
}
