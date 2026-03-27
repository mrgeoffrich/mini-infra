import { describe, it, expect } from 'vitest';
import { assign, setup } from 'xstate';
import { runStateMachineToCompletion } from '../services/stacks/state-machine-runner';

// A simple test machine that goes idle -> working -> completed or failed
const testMachine = setup({
  types: {
    context: {} as { value: number; error?: string },
    events: {} as { type: 'START' } | { type: 'DONE' } | { type: 'FAIL'; error: string },
  },
  actions: {
    setError: assign({
      error: ({ event }) => {
        if (event.type === 'FAIL') {
          return event.error;
        }
        return undefined;
      },
    }),
  },
}).createMachine({
  id: 'test',
  initial: 'idle',
  context: ({ input }) => ({ value: (input as any)?.value ?? 0 }),
  states: {
    idle: {
      on: { START: 'working' },
    },
    working: {
      on: {
        DONE: 'completed',
        FAIL: { target: 'failed', actions: 'setError' },
      },
    },
    completed: { type: 'final' },
    failed: { type: 'final' },
  },
});

describe('runStateMachineToCompletion', () => {
  it('should resolve with the final state when machine completes', async () => {
    const result = await runStateMachineToCompletion(testMachine, { value: 42 }, (actor) => {
      actor.send({ type: 'START' });
      actor.send({ type: 'DONE' });
    });

    expect(result.value).toBe('completed');
    expect(result.context.value).toBe(42);
  });

  it('should resolve with failed state', async () => {
    const result = await runStateMachineToCompletion(testMachine, { value: 0 }, (actor) => {
      actor.send({ type: 'START' });
      actor.send({ type: 'FAIL', error: 'something broke' });
    });

    expect(result.value).toBe('failed');
  });
});
