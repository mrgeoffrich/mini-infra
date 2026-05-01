import type { PrismaClient } from '../../generated/prisma/client';
import type {
  StackTlsCertificate,
  StackDnsRecord,
  StackTunnelIngress,
} from '@mini-infra/types';
import { TlsConfigService } from '../tls/tls-config';
import { StorageService } from '../storage/storage-service';
import { CloudflareService } from '../cloudflare/cloudflare-service';

export interface MissingRequirement {
  resource: 'tls' | 'dns' | 'tunnel';
  settings: string[];
  settingsUrl: string;
  reason: string;
}

export interface StackConfigurationRequirementError {
  code: 'MISSING_CONFIGURATION';
  message: string;
  missing: MissingRequirement[];
}

/**
 * Check whether a stack's resource declarations (TLS certificates, DNS
 * records, tunnel ingress) can be satisfied by the currently configured
 * integrations. Returns null if the stack has no external-resource needs
 * or all needs are met; returns a structured error otherwise.
 */
export async function checkStackConfigurationRequirements(
  prisma: PrismaClient,
  stackId: string,
): Promise<StackConfigurationRequirementError | null> {
  const stack = await prisma.stack.findUnique({
    where: { id: stackId },
    select: { tlsCertificates: true, dnsRecords: true, tunnelIngress: true },
  });
  if (!stack) return null;

  const tls = (stack.tlsCertificates as unknown as StackTlsCertificate[]) ?? [];
  const dns = (stack.dnsRecords as unknown as StackDnsRecord[]) ?? [];
  const tunnels = (stack.tunnelIngress as unknown as StackTunnelIngress[]) ?? [];

  if (tls.length === 0 && dns.length === 0 && tunnels.length === 0) {
    return null;
  }

  const tlsConfig = new TlsConfigService(prisma);
  const cloudflareConfig = new CloudflareService(prisma);

  const [storageConfigured, certContainer, cloudflareToken] = await Promise.all([
    StorageService.getInstance(prisma).isConfigured(),
    tlsConfig.getCertificateContainerNameOrNull(),
    cloudflareConfig.getApiToken(),
  ]);

  const missing: MissingRequirement[] = [];

  if (tls.length > 0) {
    const tlsGaps: string[] = [];
    if (!storageConfigured) tlsGaps.push('Storage provider (Azure Blob or Google Drive)');
    if (!certContainer) tlsGaps.push('TLS certificate storage location');
    if (!cloudflareToken) tlsGaps.push('Cloudflare API token (required for DNS-01 challenge)');
    if (tlsGaps.length > 0) {
      missing.push({
        resource: 'tls',
        settings: tlsGaps,
        // Phase 1 keeps /connectivity-azure as the page name. Phase 2 renames
        // it to /connectivity-storage; update this string then.
        settingsUrl: '/connectivity-azure',
        reason: `This stack provisions ${tls.length} TLS certificate${tls.length === 1 ? '' : 's'}.`,
      });
    }
  }

  if (dns.length > 0 && !cloudflareToken) {
    missing.push({
      resource: 'dns',
      settings: ['Cloudflare API token'],
      settingsUrl: '/connectivity-cloudflare',
      reason: `This stack manages ${dns.length} DNS record${dns.length === 1 ? '' : 's'}.`,
    });
  }

  if (tunnels.length > 0 && !cloudflareToken) {
    missing.push({
      resource: 'tunnel',
      settings: ['Cloudflare API token'],
      settingsUrl: '/connectivity-cloudflare',
      reason: `This stack configures ${tunnels.length} tunnel ingress rule${tunnels.length === 1 ? '' : 's'}.`,
    });
  }

  if (missing.length === 0) return null;

  const summary = missing
    .map((m) => `${m.reason} Configure: ${m.settings.join(', ')}.`)
    .join(' ');

  return {
    code: 'MISSING_CONFIGURATION',
    message: `This stack has external-resource requirements that aren't configured. ${summary}`,
    missing,
  };
}
