import { describe, it, expect } from 'vitest';
import {
  synthesiseDefaultNetworkIfNeeded,
  DEFAULT_STACK_NETWORK_NAME,
} from '../utils';

describe('synthesiseDefaultNetworkIfNeeded', () => {
  it('leaves declared networks untouched', () => {
    const declared = [{ name: 'shared' }, { name: 'edge' }];
    const services = [
      { serviceType: 'Stateful' },
      { serviceType: 'Stateful' },
    ];
    expect(synthesiseDefaultNetworkIfNeeded(declared, services)).toEqual(declared);
  });

  it('does nothing for single-service stacks with no declared networks', () => {
    expect(
      synthesiseDefaultNetworkIfNeeded([], [{ serviceType: 'Stateful' }]),
    ).toEqual([]);
  });

  it('synthesises a default bridge network for 2+ Stateful/StatelessWeb services', () => {
    const result = synthesiseDefaultNetworkIfNeeded(
      [],
      [
        { serviceType: 'Stateful' },
        { serviceType: 'StatelessWeb' },
      ],
    );
    expect(result).toEqual([
      { name: DEFAULT_STACK_NETWORK_NAME, driver: 'bridge' },
    ]);
  });

  it('ignores Pool services when counting container-bearing services', () => {
    // Pool + single Stateful = 1 container-bearing service → no default
    expect(
      synthesiseDefaultNetworkIfNeeded(
        [],
        [{ serviceType: 'Stateful' }, { serviceType: 'Pool' }],
      ),
    ).toEqual([]);
  });

  it('ignores AdoptedWeb services when counting container-bearing services', () => {
    expect(
      synthesiseDefaultNetworkIfNeeded(
        [],
        [{ serviceType: 'Stateful' }, { serviceType: 'AdoptedWeb' }],
      ),
    ).toEqual([]);
  });
});
