/**
 * The cheap runtime check behind the background stack-status monitor.
 *
 * This answers one question: *has reality drifted from what we last applied?*
 * It is deliberately NOT the full plan. A plan re-renders the template, expands
 * addons, inspects networks and resources, and costs several Docker calls per
 * stack — far too expensive to run on a timer across the fleet. This compares
 * two things we already have:
 *
 *   1. the container's `mini-infra.definition-hash` label — what we stamped at
 *      apply time — against `Stack.lastAppliedHashes`, our stored copy of the
 *      same values; and
 *   2. whether the container is actually running.
 *
 * Because it diffs against a stored copy of what we stamped rather than
 * re-deriving the desired hash, it cannot raise false-positive drift from a
 * benign render difference. The cost for the whole fleet is one
 * `listContainers()` (already cached for 3s) plus one Prisma read.
 *
 * The trade-off is a deliberate one: this catches "a container died, was
 * removed, or was replaced out of band" — it does NOT catch template-edit drift
 * (that needs the render) or network/resource drift. Those stay with the full
 * plan, which the user reaches by opening the plan view. Prefer false negatives
 * here; the plan remains the authority.
 */
import type { DockerContainerInfo } from "@mini-infra/types";

/** Labels the reconciler stamps on every managed container. */
export const STACK_ID_LABEL = "mini-infra.stack-id";
export const SERVICE_LABEL = "mini-infra.service";
export const DEFINITION_HASH_LABEL = "mini-infra.definition-hash";

export type RuntimeIssue =
  | { kind: "missing"; serviceName: string }
  | { kind: "not-running"; serviceName: string; status: string }
  | { kind: "hash-mismatch"; serviceName: string };

export interface StackRuntimeCheck {
  /** True when every checked service is running with the hash we applied. */
  healthy: boolean;
  issues: RuntimeIssue[];
}

/** The subset of a Stack row this check needs. */
export interface CheckableStack {
  id: string;
  /** Record<serviceName, definitionHash>, or null for pre-existing stacks. */
  lastAppliedHashes: unknown;
}

function isHashMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

/** Group a flat container list by the stack that owns each container. */
export function groupContainersByStack(
  containers: DockerContainerInfo[],
): Map<string, DockerContainerInfo[]> {
  const byStack = new Map<string, DockerContainerInfo[]>();
  for (const container of containers) {
    const stackId = container.labels?.[STACK_ID_LABEL];
    if (!stackId) continue;
    const existing = byStack.get(stackId);
    if (existing) existing.push(container);
    else byStack.set(stackId, [container]);
  }
  return byStack;
}

/**
 * Compare one stack's applied hashes against its live containers.
 *
 * Returns `null` when the stack cannot be checked — no stored hashes (applied
 * before the column existed, so we have nothing trustworthy to diff against).
 * A null result means "no opinion", and the caller must leave the status alone
 * rather than assume health.
 */
export function checkStackRuntime(
  stack: CheckableStack,
  containers: DockerContainerInfo[],
): StackRuntimeCheck | null {
  if (!isHashMap(stack.lastAppliedHashes)) return null;

  const appliedHashes = stack.lastAppliedHashes;
  const serviceNames = Object.keys(appliedHashes);
  if (serviceNames.length === 0) return null;

  // A blue-green deploy can briefly leave two containers for one service (blue
  // and green). Prefer a running one so a drain-pending blue doesn't read as a
  // dead service. Operations in flight are skipped by the caller via the
  // op-lock anyway; this is belt-and-braces for the window either side of it.
  const byService = new Map<string, DockerContainerInfo>();
  for (const container of containers) {
    const serviceName = container.labels?.[SERVICE_LABEL];
    if (!serviceName) continue;
    const existing = byService.get(serviceName);
    if (!existing || (existing.status !== "running" && container.status === "running")) {
      byService.set(serviceName, container);
    }
  }

  const issues: RuntimeIssue[] = [];

  for (const serviceName of serviceNames) {
    const container = byService.get(serviceName);

    if (!container) {
      issues.push({ kind: "missing", serviceName });
      continue;
    }

    if (container.status !== "running") {
      // The 3.1 case: a service that started and then died leaves the stack
      // `synced` with nothing running, and the badge says everything is fine
      // while the app is down.
      issues.push({ kind: "not-running", serviceName, status: container.status });
      continue;
    }

    const liveHash = container.labels?.[DEFINITION_HASH_LABEL];
    if (liveHash && liveHash !== appliedHashes[serviceName]) {
      // The 3.2 case: the container was replaced or edited out of band, so what
      // is running is not what we applied.
      issues.push({ kind: "hash-mismatch", serviceName });
    }
  }

  return { healthy: issues.length === 0, issues };
}

/** Human-readable, operator-facing summary of what the check found. */
export function describeRuntimeIssues(issues: RuntimeIssue[]): string {
  return issues
    .map((issue) => {
      switch (issue.kind) {
        case "missing":
          return `service '${issue.serviceName}' has no container`;
        case "not-running":
          return `service '${issue.serviceName}' is ${issue.status}`;
        case "hash-mismatch":
          return `service '${issue.serviceName}' does not match the applied definition`;
      }
    })
    .join("; ");
}
