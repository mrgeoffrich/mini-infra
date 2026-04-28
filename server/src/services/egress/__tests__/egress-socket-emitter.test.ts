/**
 * Tests for egress-socket-emitter helpers
 *
 * Coverage:
 *  1. Each helper builds the correct payload from its input (Date → ISO string,
 *     null handling, JSON-array targets, etc.).
 *  2. Each helper calls emitToChannel with the right Channel and ServerEvent constants.
 *  3. Failures in emitToChannel are swallowed — the helpers never throw.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Channel, ServerEvent } from '@mini-infra/types';

// ---------------------------------------------------------------------------
// Mock emitToChannel — hoisted so vi.mock can use it
// ---------------------------------------------------------------------------

const { mockEmitToChannel } = vi.hoisted(() => ({
  mockEmitToChannel: vi.fn(),
}));

vi.mock('../../../lib/socket', () => ({
  emitToChannel: mockEmitToChannel,
}));

vi.mock('../../../lib/logger-factory', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import AFTER mocks
import {
  emitEgressEvent,
  emitEgressPolicyUpdated,
  emitEgressRuleMutation,
  emitEgressGatewayHealth,
  type EgressEventRowWithSnapshots,
  type EgressPolicyRow,
  type EgressRuleRow,
} from '../egress-socket-emitter';
import type { EgressGatewayHealthEvent } from '@mini-infra/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2025-06-01T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();

function makeEventRow(overrides: Partial<EgressEventRowWithSnapshots> = {}): EgressEventRowWithSnapshots {
  return {
    id: 'evt-1',
    policyId: 'pol-1',
    occurredAt: NOW,
    sourceContainerId: 'cnt-abc',
    sourceStackId: 'stk-1',
    sourceServiceName: 'web',
    destination: 'api.openai.com',
    matchedPattern: 'api.openai.com',
    action: 'allowed',
    protocol: 'dns',
    mergedHits: 3,
    stackNameSnapshot: 'my-stack',
    environmentNameSnapshot: 'production',
    environmentId: 'env-1',
    ...overrides,
  };
}

function makePolicyRow(overrides: Partial<EgressPolicyRow> = {}): EgressPolicyRow {
  return {
    id: 'pol-1',
    stackId: 'stk-1',
    environmentId: 'env-1',
    mode: 'detect',
    defaultAction: 'allow',
    version: 5,
    appliedVersion: 4,
    archivedAt: null,
    ...overrides,
  };
}

function makeRuleRow(overrides: Partial<EgressRuleRow> = {}): EgressRuleRow {
  return {
    id: 'rule-1',
    policyId: 'pol-1',
    pattern: 'api.openai.com',
    action: 'allow',
    source: 'user',
    targets: ['web', 'api'],
    hits: 10,
    lastHitAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// emitEgressEvent
// ---------------------------------------------------------------------------

describe('emitEgressEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls emitToChannel with Channel.EGRESS and ServerEvent.EGRESS_EVENT', () => {
    emitEgressEvent(makeEventRow());

    expect(mockEmitToChannel).toHaveBeenCalledOnce();
    expect(mockEmitToChannel).toHaveBeenCalledWith(
      Channel.EGRESS,
      ServerEvent.EGRESS_EVENT,
      expect.any(Object),
    );
  });

  it('maps occurredAt Date to ISO string', () => {
    emitEgressEvent(makeEventRow({ occurredAt: NOW }));

    const payload = mockEmitToChannel.mock.calls[0][2];
    expect(payload.occurredAt).toBe(NOW_ISO);
  });

  it('includes all denormalized snapshot fields in the payload', () => {
    emitEgressEvent(makeEventRow());

    const payload = mockEmitToChannel.mock.calls[0][2];
    expect(payload).toMatchObject({
      id: 'evt-1',
      policyId: 'pol-1',
      sourceContainerId: 'cnt-abc',
      sourceStackId: 'stk-1',
      sourceServiceName: 'web',
      destination: 'api.openai.com',
      matchedPattern: 'api.openai.com',
      action: 'allowed',
      protocol: 'dns',
      mergedHits: 3,
      stackNameSnapshot: 'my-stack',
      environmentNameSnapshot: 'production',
      environmentId: 'env-1',
    });
  });

  it('handles null optional fields correctly', () => {
    emitEgressEvent(makeEventRow({
      sourceContainerId: null,
      sourceStackId: null,
      sourceServiceName: null,
      matchedPattern: null,
      environmentId: null,
    }));

    const payload = mockEmitToChannel.mock.calls[0][2];
    expect(payload.sourceContainerId).toBeNull();
    expect(payload.sourceStackId).toBeNull();
    expect(payload.sourceServiceName).toBeNull();
    expect(payload.matchedPattern).toBeNull();
    expect(payload.environmentId).toBeNull();
  });

  it('does not throw when emitToChannel throws', () => {
    mockEmitToChannel.mockImplementationOnce(() => {
      throw new Error('socket failure');
    });

    expect(() => emitEgressEvent(makeEventRow())).not.toThrow();
  });

  it('does not re-throw when emitToChannel throws — swallows the error', () => {
    const error = new Error('socket down');
    mockEmitToChannel.mockImplementationOnce(() => { throw error; });

    let thrown: unknown = null;
    try {
      emitEgressEvent(makeEventRow());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// emitEgressPolicyUpdated
// ---------------------------------------------------------------------------

describe('emitEgressPolicyUpdated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls emitToChannel with Channel.EGRESS and ServerEvent.EGRESS_POLICY_UPDATED', () => {
    emitEgressPolicyUpdated(makePolicyRow());

    expect(mockEmitToChannel).toHaveBeenCalledOnce();
    expect(mockEmitToChannel).toHaveBeenCalledWith(
      Channel.EGRESS,
      ServerEvent.EGRESS_POLICY_UPDATED,
      expect.any(Object),
    );
  });

  it('maps archivedAt Date to ISO string', () => {
    emitEgressPolicyUpdated(makePolicyRow({ archivedAt: NOW }));

    const payload = mockEmitToChannel.mock.calls[0][2];
    expect(payload.archivedAt).toBe(NOW_ISO);
  });

  it('maps archivedAt null to null', () => {
    emitEgressPolicyUpdated(makePolicyRow({ archivedAt: null }));

    const payload = mockEmitToChannel.mock.calls[0][2];
    expect(payload.archivedAt).toBeNull();
  });

  it('includes all policy fields in payload', () => {
    emitEgressPolicyUpdated(makePolicyRow());

    const payload = mockEmitToChannel.mock.calls[0][2];
    expect(payload).toMatchObject({
      policyId: 'pol-1',
      environmentId: 'env-1',
      stackId: 'stk-1',
      version: 5,
      appliedVersion: 4,
      mode: 'detect',
      defaultAction: 'allow',
      archivedAt: null,
    });
  });

  it('handles null stackId and environmentId', () => {
    emitEgressPolicyUpdated(makePolicyRow({ stackId: null, environmentId: null, appliedVersion: null }));

    const payload = mockEmitToChannel.mock.calls[0][2];
    expect(payload.stackId).toBeNull();
    expect(payload.environmentId).toBeNull();
    expect(payload.appliedVersion).toBeNull();
  });

  it('does not throw when emitToChannel throws', () => {
    mockEmitToChannel.mockImplementationOnce(() => {
      throw new Error('socket failure');
    });

    expect(() => emitEgressPolicyUpdated(makePolicyRow())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// emitEgressRuleMutation
// ---------------------------------------------------------------------------

describe('emitEgressRuleMutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls emitToChannel with Channel.EGRESS and ServerEvent.EGRESS_RULE_MUTATION', () => {
    emitEgressRuleMutation({
      policy: makePolicyRow(),
      ruleId: 'rule-1',
      changeType: 'created',
      rule: makeRuleRow(),
    });

    expect(mockEmitToChannel).toHaveBeenCalledOnce();
    expect(mockEmitToChannel).toHaveBeenCalledWith(
      Channel.EGRESS,
      ServerEvent.EGRESS_RULE_MUTATION,
      expect.any(Object),
    );
  });

  it('builds an EgressRuleSummary from the rule row', () => {
    const rule = makeRuleRow({ targets: ['web', 'api'] });
    emitEgressRuleMutation({ policy: makePolicyRow(), ruleId: 'rule-1', changeType: 'created', rule });

    const payload = mockEmitToChannel.mock.calls[0][2];
    expect(payload.rule).toMatchObject({
      id: 'rule-1',
      policyId: 'pol-1',
      pattern: 'api.openai.com',
      action: 'allow',
      source: 'user',
      targets: ['web', 'api'],
      hits: 10,
      lastHitAt: NOW_ISO,
    });
  });

  it('maps rule.lastHitAt Date to ISO string', () => {
    emitEgressRuleMutation({
      policy: makePolicyRow(),
      ruleId: 'rule-1',
      changeType: 'updated',
      rule: makeRuleRow({ lastHitAt: NOW }),
    });

    const payload = mockEmitToChannel.mock.calls[0][2];
    expect(payload.rule!.lastHitAt).toBe(NOW_ISO);
  });

  it('maps rule.lastHitAt null to null', () => {
    emitEgressRuleMutation({
      policy: makePolicyRow(),
      ruleId: 'rule-1',
      changeType: 'updated',
      rule: makeRuleRow({ lastHitAt: null }),
    });

    const payload = mockEmitToChannel.mock.calls[0][2];
    expect(payload.rule!.lastHitAt).toBeNull();
  });

  it('handles non-array targets by defaulting to empty array', () => {
    emitEgressRuleMutation({
      policy: makePolicyRow(),
      ruleId: 'rule-1',
      changeType: 'updated',
      rule: makeRuleRow({ targets: null as unknown as string[] }),
    });

    const payload = mockEmitToChannel.mock.calls[0][2];
    expect(payload.rule!.targets).toEqual([]);
  });

  it('sets rule to null for changeType=deleted', () => {
    emitEgressRuleMutation({
      policy: makePolicyRow(),
      ruleId: 'rule-1',
      changeType: 'deleted',
      rule: null,
    });

    const payload = mockEmitToChannel.mock.calls[0][2];
    expect(payload.rule).toBeNull();
    expect(payload.changeType).toBe('deleted');
    expect(payload.ruleId).toBe('rule-1');
    expect(payload.policyId).toBe('pol-1');
  });

  it('does not throw when emitToChannel throws', () => {
    mockEmitToChannel.mockImplementationOnce(() => {
      throw new Error('socket failure');
    });

    expect(() =>
      emitEgressRuleMutation({
        policy: makePolicyRow(),
        ruleId: 'rule-1',
        changeType: 'created',
        rule: makeRuleRow(),
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// emitEgressGatewayHealth
// ---------------------------------------------------------------------------

describe('emitEgressGatewayHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeHealthSnapshot = (overrides: Partial<EgressGatewayHealthEvent> = {}): EgressGatewayHealthEvent => ({
    environmentId: 'env-1',
    gatewayIp: '172.30.0.2',
    ok: true,
    rulesVersion: 3,
    appliedRulesVersion: 3,
    containerMapVersion: 2,
    appliedContainerMapVersion: 2,
    upstream: {
      servers: ['172.30.0.10'],
      lastSuccessAt: NOW_ISO,
      lastFailureAt: null,
    },
    ...overrides,
  });

  it('calls emitToChannel with Channel.EGRESS and ServerEvent.EGRESS_GATEWAY_HEALTH', () => {
    emitEgressGatewayHealth(makeHealthSnapshot());

    expect(mockEmitToChannel).toHaveBeenCalledOnce();
    expect(mockEmitToChannel).toHaveBeenCalledWith(
      Channel.EGRESS,
      ServerEvent.EGRESS_GATEWAY_HEALTH,
      expect.any(Object),
    );
  });

  it('passes the snapshot payload through unchanged', () => {
    const snapshot = makeHealthSnapshot();
    emitEgressGatewayHealth(snapshot);

    const payload = mockEmitToChannel.mock.calls[0][2];
    expect(payload).toEqual(snapshot);
  });

  it('handles ok=false with errorMessage', () => {
    const snapshot = makeHealthSnapshot({
      ok: false,
      appliedRulesVersion: null,
      errorMessage: 'connection refused',
      upstream: { servers: [], lastSuccessAt: null, lastFailureAt: NOW_ISO },
    });
    emitEgressGatewayHealth(snapshot);

    const payload = mockEmitToChannel.mock.calls[0][2];
    expect(payload.ok).toBe(false);
    expect(payload.errorMessage).toBe('connection refused');
    expect(payload.appliedRulesVersion).toBeNull();
  });

  it('handles null gatewayIp', () => {
    emitEgressGatewayHealth(makeHealthSnapshot({ gatewayIp: null }));

    const payload = mockEmitToChannel.mock.calls[0][2];
    expect(payload.gatewayIp).toBeNull();
  });

  it('does not throw when emitToChannel throws', () => {
    mockEmitToChannel.mockImplementationOnce(() => {
      throw new Error('socket failure');
    });

    expect(() => emitEgressGatewayHealth(makeHealthSnapshot())).not.toThrow();
  });
});
