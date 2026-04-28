// Egress Firewall Types

export type EgressMode = 'detect' | 'enforce';
export type EgressDefaultAction = 'allow' | 'block';
export type EgressRuleAction = 'allow' | 'block';
export type EgressRuleSource = 'user' | 'observed' | 'template';
export type EgressEventAction = 'allowed' | 'blocked' | 'observed';
export type EgressEventProtocol = 'dns' | 'sni' | 'http';
export type EgressArchivedReason = 'stack-deleted' | 'environment-deleted';

export interface EgressPolicySummary {
  id: string;
  stackId: string | null;
  stackNameSnapshot: string;
  environmentId: string | null;
  environmentNameSnapshot: string;
  mode: EgressMode;
  defaultAction: EgressDefaultAction;
  version: number;
  appliedVersion: number | null;
  archivedAt: string | null;
  archivedReason: EgressArchivedReason | null;
}

export interface EgressRuleSummary {
  id: string;
  policyId: string;
  pattern: string;
  action: EgressRuleAction;
  source: EgressRuleSource;
  targets: string[];
  hits: number;
  lastHitAt: string | null;
}
