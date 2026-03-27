import { createActor, AnyStateMachine } from 'xstate';

/**
 * Runs an xstate machine to completion and returns the final state.
 * The `start` callback receives the actor and should send the initial event(s).
 * For async state machines where actions send events internally, the promise
 * resolves when the machine reaches a final state.
 */
export function runStateMachineToCompletion(
  machine: AnyStateMachine,
  input: Record<string, unknown>,
  start: (actor: any) => void
): Promise<{ value: any; status: string; context: any }> {
  return new Promise((resolve) => {
    const actor = createActor(machine, { input } as any);

    actor.subscribe((state: any) => {
      if (state.status === 'done') {
        resolve(state);
      }
    });

    actor.start();
    start(actor);
  });
}
