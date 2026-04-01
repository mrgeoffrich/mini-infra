import { ServiceApplyResult, ResourceResult, ResourceType } from '@mini-infra/types';

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const actionLabels: Record<string, string> = {
  create: 'Creating',
  recreate: 'Recreating',
  remove: 'Removing',
  update: 'Updating',
};

const resourceGroupLabels: Record<ResourceType, string> = {
  tls: 'TLS certificates',
  dns: 'DNS records',
  tunnel: 'tunnel ingress',
};

export function formatPlanStep(
  stepNum: number,
  totalSteps: number,
  counts: { creates: number; recreates: number; removes: number; updates: number },
): string {
  let summary = `${counts.creates} to create, ${counts.recreates} to recreate, ${counts.removes} to remove`;
  if (counts.updates > 0) {
    summary += `, ${counts.updates} to update`;
  }
  return (
    `[${stepNum}/${totalSteps}] Planning stack changes...\n` +
    `      → ${summary}\n`
  );
}

export function formatServiceStep(
  stepNum: number,
  totalSteps: number,
  result: ServiceApplyResult,
): string {
  const label = actionLabels[result.action] ?? result.action;
  let output = `[${stepNum}/${totalSteps}] ${label} service: ${result.serviceName}\n`;

  if (result.success) {
    output += `      ✓ Completed (${formatDuration(result.duration)})\n`;
  } else {
    output += `      ✗ Failed (${formatDuration(result.duration)})\n`;
    if (result.error) {
      output += `        Error: ${result.error}\n`;
    }
  }

  return output;
}

export function formatResourceGroupStep(
  stepNum: number,
  totalSteps: number,
  resourceType: ResourceType,
  results: ResourceResult[],
): string {
  const label = resourceGroupLabels[resourceType];
  let output = `[${stepNum}/${totalSteps}] Reconciling ${label}\n`;

  for (const r of results) {
    if (r.success) {
      output += `      ✓ ${r.resourceName} — ${r.action}\n`;
    } else {
      output += `      ✗ ${r.resourceName} — ${r.action}${r.error ? ': ' + r.error : ''}\n`;
    }
  }

  return output;
}

export function formatDestroyResourceStep(
  stepNum: number,
  totalSteps: number,
  success: boolean,
  error?: string,
): string {
  let output = `[${stepNum}/${totalSteps}] Destroying stack resources (TLS, DNS, tunnels)\n`;
  if (success) {
    output += `      ✓ Resources cleaned up\n`;
  } else {
    output += `      ✗ Failed${error ? ': ' + error : ''}\n`;
  }
  return output;
}

export function formatDestroyContainerStep(
  stepNum: number,
  totalSteps: number,
  removed: number,
  total: number,
): string {
  let output = `[${stepNum}/${totalSteps}] Removing containers\n`;
  if (removed === total) {
    output += `      ✓ ${removed} of ${total} containers removed\n`;
  } else {
    output += `      ✗ ${removed} of ${total} containers removed (${total - removed} failed)\n`;
  }
  return output;
}

export function formatDestroyNetworkStep(
  stepNum: number,
  totalSteps: number,
  networksRemoved: string[],
): string {
  let output = `[${stepNum}/${totalSteps}] Removing networks\n`;
  if (networksRemoved.length === 0) {
    output += `      ✓ No networks to remove\n`;
  } else {
    output += `      ✓ Removed: ${networksRemoved.join(', ')}\n`;
  }
  return output;
}

export function formatDestroyVolumeStep(
  stepNum: number,
  totalSteps: number,
  volumesRemoved: string[],
): string {
  let output = `[${stepNum}/${totalSteps}] Removing volumes\n`;
  if (volumesRemoved.length === 0) {
    output += `      ✓ No volumes to remove\n`;
  } else {
    output += `      ✓ Removed: ${volumesRemoved.join(', ')}\n`;
  }
  return output;
}
