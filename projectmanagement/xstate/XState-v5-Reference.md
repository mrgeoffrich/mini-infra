# XState v5 Reference Guide

XState v5 is an actor-based state management solution that uses state machines, statecharts, and the actor model for predictable application logic in JavaScript and TypeScript applications.

## Installation

```bash
npm install xstate
```

## Core Concepts

### 1. State Machines
State machines are event-driven behavioral and logical models that define states, transitions, and actions in a predictable way.

### 2. Actors
Actors are instances of state machines that can:
- Send and receive events
- Maintain their own state and context
- Spawn other actors
- Communicate with parent/child actors

### 3. Context
Extended state that persists across state transitions, managed immutably using `assign()`.

## Basic Usage

### Creating a Simple State Machine

```typescript
import { createMachine, createActor, assign } from 'xstate';

// Define the state machine
const toggleMachine = createMachine({
  id: 'toggle',
  initial: 'inactive',
  context: {
    count: 0
  },
  states: {
    inactive: {
      on: {
        TOGGLE: { target: 'active' }
      }
    },
    active: {
      entry: assign({ count: ({ context }) => context.count + 1 }),
      on: {
        TOGGLE: { target: 'inactive' }
      }
    }
  }
});

// Create and use an actor
const toggleActor = createActor(toggleMachine);
toggleActor.subscribe((state) => console.log(state.value, state.context));
toggleActor.start();
// => logs 'inactive', { count: 0 }

toggleActor.send({ type: 'TOGGLE' });
// => logs 'active', { count: 1 }
```

### Traffic Light Example

```javascript
import { createMachine, createActor } from 'xstate';

const lightMachine = createMachine({
  id: 'light',
  initial: 'green',
  states: {
    green: {
      on: {
        TIMER: 'yellow'
      }
    },
    yellow: {
      on: {
        TIMER: 'red'
      }
    },
    red: {
      on: {
        TIMER: 'green'
      }
    }
  }
});

const actor = createActor(lightMachine);
actor.subscribe((state) => console.log(state.value));
actor.start();
// logs 'green'

actor.send({ type: 'TIMER' });
// logs 'yellow'
```

## Context Management

Context represents the extended state of a machine and should be updated immutably using `assign()`:

```typescript
import { createMachine, assign } from 'xstate';

const glassMachine = createMachine({
  id: 'glass',
  context: {
    amount: 0
  },
  initial: 'empty',
  states: {
    empty: {
      on: {
        FILL: {
          target: 'filling',
          actions: assign({
            amount: ({ context }) => context.amount + 1
          })
        }
      }
    },
    filling: {
      always: {
        target: 'full',
        guard: ({ context }) => context.amount >= 10
      },
      on: {
        FILL: {
          target: 'filling',
          actions: assign({
            amount: ({ context }) => context.amount + 1
          })
        }
      }
    },
    full: {}
  }
});
```

### Accessing Context from State

```javascript
const nextState = glassMachine.transition(glassMachine.initialState, {
  type: 'FILL'
});

console.log(nextState.context);
// => { amount: 1 }
```

## Guards (Conditions)

Guards are functions that determine whether a transition should occur:

```typescript
const gameMachine = createMachine({
  id: 'game',
  initial: 'playing',
  context: {
    points: 0
  },
  states: {
    playing: {
      // Eventless transitions (always checked)
      always: [
        { target: 'win', guard: ({ context }) => context.points > 99 },
        { target: 'lose', guard: ({ context }) => context.points < 0 }
      ],
      on: {
        AWARD_POINTS: {
          actions: assign({
            points: 100
          })
        }
      }
    },
    win: { type: 'final' },
    lose: { type: 'final' }
  }
});
```

### Guards with Machine Options

```javascript
const searchMachine = createMachine({
  id: 'search',
  initial: 'idle',
  context: {
    canSearch: true
  },
  states: {
    idle: {
      on: {
        SEARCH: [
          {
            target: 'searching',
            guard: 'searchValid'
          },
          { target: '.invalid' }
        ]
      }
    },
    searching: {
      entry: 'executeSearch'
    }
  }
}, {
  guards: {
    searchValid: ({ context, event }) => {
      return context.canSearch && event.query && event.query.length > 0;
    }
  }
});
```

## Actions

Actions are side effects that occur during state transitions or state entry/exit.

### Entry, Exit, and Transition Actions

```javascript
const triggerMachine = createMachine({
  id: 'trigger',
  initial: 'inactive',
  states: {
    inactive: {
      on: {
        TRIGGER: {
          target: 'active',
          // Transition actions
          actions: ['activate', 'sendTelemetry']
        }
      }
    },
    active: {
      // Entry actions
      entry: ['notifyActive', 'sendTelemetry'],
      // Exit actions
      exit: ['notifyInactive', 'sendTelemetry'],
      on: {
        STOP: { target: 'inactive' }
      }
    }
  }
}, {
  actions: {
    activate: () => console.log('activating...'),
    notifyActive: () => console.log('active!'),
    notifyInactive: () => console.log('inactive!'),
    sendTelemetry: () => console.log('time:', Date.now())
  }
});
```

### Sequential Actions

Actions execute in the order they are defined. Assign actions execute first, then custom actions:

```javascript
const counterMachine = createMachine({
  id: 'counter',
  context: { count: 0 },
  initial: 'active',
  states: {
    active: {
      on: {
        INC_TWICE: {
          actions: [
            ({ context }) => console.log(`Before: ${context.count}`),
            assign({ count: ({ context }) => context.count + 1 }), // count === 1
            assign({ count: ({ context }) => context.count + 1 }), // count === 2
            ({ context }) => console.log(`After: ${context.count}`)
          ]
        }
      }
    }
  }
});
```

## Parallel States

Parallel states allow multiple states to be active simultaneously:

```typescript
const wordMachine = createMachine({
  id: 'word',
  type: 'parallel',
  states: {
    bold: {
      initial: 'off',
      states: {
        on: {
          on: { TOGGLE_BOLD: 'off' }
        },
        off: {
          on: { TOGGLE_BOLD: 'on' }
        }
      }
    },
    underline: {
      initial: 'off',
      states: {
        on: {
          on: { TOGGLE_UNDERLINE: 'off' }
        },
        off: {
          on: { TOGGLE_UNDERLINE: 'on' }
        }
      }
    },
    italics: {
      initial: 'off',
      states: {
        on: {
          on: { TOGGLE_ITALICS: 'off' }
        },
        off: {
          on: { TOGGLE_ITALICS: 'on' }
        }
      }
    }
  }
});
```

## Hierarchical States

Nested states allow for complex state hierarchies:

```javascript
const lightMachine = createMachine({
  id: 'light',
  initial: 'green',
  states: {
    green: {
      on: {
        TIMER: 'yellow'
      }
    },
    yellow: {
      on: {
        TIMER: 'red'
      }
    },
    red: {
      on: {
        TIMER: 'green'
      },
      initial: 'walk',
      states: {
        walk: {
          on: {
            PED_TIMER: 'wait'
          }
        },
        wait: {
          on: {
            PED_TIMER: 'stop'
          }
        },
        stop: {}
      }
    }
  }
});
```

## History States

History states remember the last active child state:

```javascript
const paymentMachine = createMachine({
  id: 'payment',
  initial: 'method',
  states: {
    method: {
      initial: 'cash',
      states: {
        cash: {
          on: {
            SWITCH_CHECK: 'check'
          }
        },
        check: {
          on: {
            SWITCH_CASH: 'cash'
          }
        },
        hist: { type: 'history' }
      },
      on: { NEXT: 'review' }
    },
    review: {
      on: { PREVIOUS: 'method.hist' }
    }
  }
});
```

## TypeScript Support

XState v5 provides excellent TypeScript support:

```typescript
interface LightContext {
  elapsed: number;
}

type LightEvent =
  | { type: 'TIMER' }
  | { type: 'POWER_OUTAGE' }
  | { type: 'PED_COUNTDOWN'; duration: number };

const lightMachine = createMachine<LightContext, LightEvent>({
  id: 'light',
  initial: 'green',
  context: { elapsed: 0 },
  states: {
    green: {
      on: {
        TIMER: { target: 'yellow' },
        POWER_OUTAGE: { target: 'red' }
      }
    }
    // ... other states
  }
});
```

## Actor Management

### Creating and Managing Actors

```typescript
// Create actor
const actor = createActor(machine);

// Subscribe to state changes
const subscription = actor.subscribe((state) => {
  console.log(state.value, state.context);
});

// Start the actor
actor.start();

// Send events
actor.send({ type: 'SOME_EVENT' });

// Stop the actor
actor.stop();

// Unsubscribe
subscription.unsubscribe();
```

### Actor Communication

Actors can communicate with each other through events:

```typescript
import { createMachine, sendUpdate } from 'xstate';

const childMachine = createMachine({
  on: {
    SOME_EVENT: {
      actions: [
        // Send update to parent
        sendUpdate()
      ]
    }
  }
});
```

## Key Changes from v4 to v5

1. **Actors instead of Services**: Use `createActor()` instead of `interpret()`
2. **Simplified API**: More consistent naming and structure
3. **Better TypeScript support**: Enhanced type safety throughout
4. **Guards**: Use `guard` instead of `cond` for conditions
5. **Context updates**: Updated `assign()` function signature
6. **Improved error handling**: Better error messages and debugging

## Best Practices

1. **Keep machines focused**: Each machine should handle a specific concern
2. **Use context sparingly**: Only store data that affects state transitions
3. **Leverage TypeScript**: Use proper typing for better development experience
4. **Test state machines**: They're highly testable by design
5. **Use guards for complex logic**: Keep transition logic in guards rather than actions
6. **Organize actions**: Define actions in machine options for reusability

## Resources

- [Official XState Documentation](https://xstate.js.org/)
- [Stately Studio](https://stately.ai/studio) - Visual state machine editor
- [XState Examples](https://github.com/statelyai/xstate/tree/main/examples)

## Integration with Mini Infra

The Mini Infra project already uses XState v5 in the `DeploymentOrchestrator` service for managing deployment workflows with sophisticated state machines that handle:

- Image pulling and validation
- Container lifecycle management  
- Health checking and monitoring
- Traffic switching for zero-downtime deployments
- Rollback capabilities
- Progress tracking and logging

This demonstrates XState's power for managing complex, multi-step processes with clear state transitions and error handling.