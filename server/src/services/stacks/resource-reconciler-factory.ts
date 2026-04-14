import prisma from '../../lib/prisma';
import { StackResourceReconciler } from './stack-resource-reconciler';
import { CertificateLifecycleManager } from '../tls/certificate-lifecycle-manager';
import { AcmeClientManager } from '../tls/acme-client-manager';
import { AzureStorageCertificateStore } from '../tls/azure-storage-certificate-store';
import { DnsChallenge01Provider } from '../tls/dns-challenge-provider';
import { CertificateDistributor } from '../tls/certificate-distributor';
import { CloudflareDNSService } from '../cloudflare/cloudflare-dns';
import { CloudflareService } from '../cloudflare';
import { TlsConfigService } from '../tls/tls-config';
import { AzureStorageService } from '../azure-storage-service';
import { HAProxyService } from '../haproxy/haproxy-service';
import { DockerExecutorService } from '../docker-executor';

/**
 * Create a StackResourceReconciler with all required dependencies.
 * Initializes TLS lifecycle manager (ACME client, Azure storage, DNS challenge provider)
 * along with Cloudflare DNS and HAProxy certificate deployer services.
 *
 * If Azure storage is not configured, TLS methods on the returned reconciler
 * throw a descriptive error when invoked.
 */
export async function createResourceReconciler(): Promise<StackResourceReconciler> {
  const tlsConfig = new TlsConfigService(prisma);
  const azureConfig = new AzureStorageService(prisma);

  const containerName = await tlsConfig.getCertificateContainerName();
  const connectionString = await azureConfig.getConnectionString();

  let certLifecycleManager: CertificateLifecycleManager | undefined;
  const cloudflareConfig = new CloudflareService(prisma);

  if (connectionString) {
    const certificateStore = new AzureStorageCertificateStore(connectionString, containerName);
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
    issueCertificate: () => { throw new Error('TLS provisioning requires Azure Storage configuration'); },
    renewCertificate: () => { throw new Error('TLS provisioning requires Azure Storage configuration'); },
    revokeCertificate: () => { throw new Error('TLS provisioning requires Azure Storage configuration'); },
  } as unknown as CertificateLifecycleManager);

  return new StackResourceReconciler(
    prisma,
    effectiveCertManager,
    new CloudflareDNSService(),
    cloudflareConfig,
  );
}
