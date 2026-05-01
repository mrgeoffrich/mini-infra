import prisma from '../../lib/prisma';
import { StackResourceReconciler } from './stack-resource-reconciler';
import { CertificateLifecycleManager } from '../tls/certificate-lifecycle-manager';
import { AcmeClientManager } from '../tls/acme-client-manager';
import { StorageCertificateStore } from '../tls/storage-certificate-store';
import { DnsChallenge01Provider } from '../tls/dns-challenge-provider';
import { CertificateDistributor } from '../tls/certificate-distributor';
import { CloudflareDNSService } from '../cloudflare/cloudflare-dns';
import { CloudflareService } from '../cloudflare';
import { TlsConfigService } from '../tls/tls-config';
import { StorageService } from '../storage/storage-service';
import { HAProxyService } from '../haproxy/haproxy-service';
import { DockerExecutorService } from '../docker-executor';

/**
 * Create a StackResourceReconciler with all required dependencies.
 *
 * The TLS lifecycle manager only initializes if both a storage provider is
 * active AND a certificate storage location is configured. Otherwise the
 * reconciler returns a stub that throws on TLS calls only — callers that
 * require TLS must preflight with `checkStackConfigurationRequirements()`.
 */
export async function createResourceReconciler(): Promise<StackResourceReconciler> {
  const tlsConfig = new TlsConfigService(prisma);

  let storageBackend;
  try {
    storageBackend = await StorageService.getInstance(prisma).getActiveBackend();
  } catch {
    storageBackend = null;
  }

  const containerName = storageBackend
    ? await tlsConfig.getCertificateContainerNameOrNull()
    : null;

  let certLifecycleManager: CertificateLifecycleManager | undefined;
  const cloudflareConfig = new CloudflareService(prisma);

  if (storageBackend && containerName) {
    const certificateStore = new StorageCertificateStore(storageBackend, containerName);
    const acmeClient = new AcmeClientManager(tlsConfig, certificateStore);
    const dnsChallenge = new DnsChallenge01Provider(cloudflareConfig);

    await acmeClient.initialize();

    const haproxyService = new HAProxyService();
    const dockerExec = new DockerExecutorService();
    await dockerExec.initialize();
    const distributor = new CertificateDistributor(certificateStore, haproxyService, dockerExec);

    certLifecycleManager = new CertificateLifecycleManager(
      acmeClient,
      certificateStore,
      dnsChallenge,
      prisma,
      containerName,
      distributor,
    );
  }

  const effectiveCertManager: CertificateLifecycleManager = certLifecycleManager ?? ({
    issueCertificate: () => { throw new Error('TLS provisioning requires a configured storage provider'); },
    renewCertificate: () => { throw new Error('TLS provisioning requires a configured storage provider'); },
    revokeCertificate: () => { throw new Error('TLS provisioning requires a configured storage provider'); },
  } as unknown as CertificateLifecycleManager);

  return new StackResourceReconciler(
    prisma,
    effectiveCertManager,
    new CloudflareDNSService(),
    cloudflareConfig,
  );
}
