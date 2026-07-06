import type { ManagedNetworkMembershipView, ManagedNetworkView } from "@mini-infra/types";

/**
 * Plain (non-component) label helpers for the network overhaul Phase 9
 * visibility UI — split out of `managed-network-shared.tsx` so that file can
 * stay component-only (mixing component and non-component exports in one
 * file breaks Vite's fast-refresh boundary detection).
 */

/** Human-readable label for who/what a membership targets — service name (with owning stack, when known), the literal adopted/external container name, or "mini-infra server" for the `self` sentinel. */
export function membershipTargetLabel(m: ManagedNetworkMembershipView): string {
  if (m.containerName === "self") return "mini-infra server";
  if (m.containerName) return m.containerName;
  if (m.serviceName) return m.stackName ? `${m.stackName} / ${m.serviceName}` : m.serviceName;
  return "Unknown target";
}

/** Human-readable owner label — "Host", the resolved environment name, or the resolved stack name, matching `ManagedNetworkView.scope`. */
export function networkOwnerLabel(view: ManagedNetworkView): string {
  if (view.scope === "host") return "Host";
  if (view.scope === "environment") return view.environmentName ?? view.environmentId ?? "Unknown environment";
  return view.stackName ?? view.stackId ?? "Unknown stack";
}

export const SCOPE_LABEL: Record<ManagedNetworkView["scope"], string> = {
  host: "Host",
  environment: "Environment",
  stack: "Stack",
};
