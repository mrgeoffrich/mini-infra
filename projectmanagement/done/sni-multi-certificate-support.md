# SNI Multi-Certificate Support for HAProxy

## Problem Statement

When multiple applications are deployed with different TLS certificates on the same shared HTTPS frontend, HAProxy serves the wrong certificate. This is because the current implementation binds a single certificate file to port 443, and subsequent deployments upload their certificates but don't add them to the bind configuration.

### Current Behavior

1. First HTTPS deployment (domain-a.com) creates shared frontend with bind: `bind *:443 ssl crt /etc/haproxy/ssl/domain_a_com.pem`
2. Second HTTPS deployment (domain-b.com) uploads its certificate to HAProxy storage
3. A route (ACL + backend switching rule) is added for domain-b.com
4. **But the bind still only references domain-a's certificate**
5. Result: Visitors to domain-b.com receive domain-a's certificate (wrong!)

## Solution: Directory-Based SNI

HAProxy supports pointing the `crt` directive at a directory instead of a specific file:
```
bind *:443 ssl crt /etc/haproxy/ssl/
```

With this configuration, HAProxy:
- Loads all `.pem` files from the directory
- Uses SNI (Server Name Indication) to match the client's requested hostname
- Serves the certificate whose CN or SAN matches the hostname

## Implementation Plan

### File Changes Required

#### 1. `server/src/services/haproxy/haproxy-frontend-manager.ts`

##### A. Modify `configureSharedFrontendSSL` (lines 815-899)

**Current code (lines 885-893):**
```typescript
await haproxyClient.addFrontendBind(
  frontendName,
  bindAddress,
  bindPort,
  {
    ssl: true,
    ssl_certificate: `/etc/haproxy/ssl/${certFileName}`,
  }
);
```

**Change to:**
```typescript
await haproxyClient.addFrontendBind(
  frontendName,
  bindAddress,
  bindPort,
  {
    ssl: true,
    ssl_certificate: `/etc/haproxy/ssl/`,  // Directory path for SNI
  }
);
```

##### B. Modify `addRouteToSharedFrontend` (lines 914-1022)

After the `addHostnameRouting` call (line 984), add certificate upload logic:

```typescript
// Add ACL and backend switching rule to HAProxy
await this.addHostnameRouting(
  frontendName,
  hostname,
  backendName,
  haproxyClient
);

// NEW: If SSL is enabled and we have a certificate, upload it to HAProxy
// This ensures the certificate is in /etc/haproxy/ssl/ for SNI selection
if (sslOptions?.useSSL && sslOptions?.tlsCertificateId) {
  await this.uploadCertificateForSNI(
    sslOptions.tlsCertificateId,
    prisma,
    haproxyClient
  );
}
```

##### C. Add new helper method `uploadCertificateForSNI`

Add this new private method to the `HAProxyFrontendManager` class:

```typescript
/**
 * Upload a certificate to HAProxy storage for SNI-based selection.
 *
 * The certificate is uploaded to /etc/haproxy/ssl/ where the shared
 * HTTPS frontend bind is pointing. HAProxy will automatically select
 * the correct certificate based on the SNI hostname.
 *
 * @param tlsCertificateId The TLS certificate ID from database
 * @param prisma Prisma client instance
 * @param haproxyClient HAProxy DataPlane client instance
 */
private async uploadCertificateForSNI(
  tlsCertificateId: string,
  prisma: PrismaClient,
  haproxyClient: HAProxyDataPlaneClient
): Promise<void> {
  logger.info(
    { tlsCertificateId },
    "Uploading certificate to HAProxy for SNI selection"
  );

  // Get certificate from database
  const certificate = await prisma.tlsCertificate.findUnique({
    where: { id: tlsCertificateId },
  });

  if (!certificate) {
    logger.warn({ tlsCertificateId }, "Certificate not found, skipping upload");
    return;
  }

  if (!certificate.blobName) {
    logger.warn({ tlsCertificateId }, "Certificate blob name not found, skipping upload");
    return;
  }

  // Initialize TLS config and Azure Storage client
  const tlsConfig = new TlsConfigService(prisma);
  const azureConfig = new AzureConfigService(prisma);

  const containerName = await tlsConfig.getCertificateContainerName();
  const connectionString = await azureConfig.getConnectionString();

  if (!connectionString) {
    throw new Error("Azure Storage not configured");
  }

  const certificateStore = new AzureStorageCertificateStore(connectionString, containerName);

  // Get certificate from Azure Storage
  logger.info(
    { blobName: certificate.blobName },
    "Retrieving certificate from Azure Storage for SNI"
  );

  const certData = await certificateStore.getCertificate(certificate.blobName);

  // Combine certificate and private key for HAProxy
  // Use domain name for filename - HAProxy matches by CN/SAN in the certificate
  const combinedPem = `${certData.certificate}\n${certData.privateKey}`;
  const certFileName = `${certificate.primaryDomain.replace(/[^a-zA-Z0-9]/g, "_")}.pem`;

  // Upload or update certificate in HAProxy
  try {
    await haproxyClient.updateSSLCertificate(certFileName, combinedPem, false);
    logger.info({ certFileName }, "Updated existing SSL certificate for SNI");
  } catch (updateError: any) {
    if (updateError.message?.includes("not found") || updateError.message?.includes("404")) {
      await haproxyClient.uploadSSLCertificate(certFileName, combinedPem, false);
      logger.info({ certFileName }, "Uploaded new SSL certificate for SNI");
    } else {
      throw updateError;
    }
  }

  logger.info(
    { certFileName, tlsCertificateId, primaryDomain: certificate.primaryDomain },
    "Certificate uploaded successfully for SNI selection"
  );
}
```

##### D. Update imports if needed

Ensure these imports are present at the top of the file:
```typescript
import { AzureStorageCertificateStore } from "../tls/azure-storage-certificate-store";
import { TlsConfigService } from "../tls/tls-config";
import { AzureConfigService } from "../azure-config";
```

### Flow After Implementation

#### First HTTPS Deployment (domain-a.com)

1. `getOrCreateSharedFrontend` is called with type="https"
2. No existing shared frontend found
3. Creates frontend in HAProxy
4. Calls `configureSharedFrontendSSL`:
   - Uploads `domain_a_com.pem` to `/etc/haproxy/ssl/`
   - Creates bind: `bind *:443 ssl crt /etc/haproxy/ssl/`
5. `addRouteToSharedFrontend` is called:
   - Adds ACL for domain-a.com
   - Calls `uploadCertificateForSNI` (certificate already uploaded, will update)

#### Second HTTPS Deployment (domain-b.com)

1. `getOrCreateSharedFrontend` is called with type="https"
2. **Existing shared frontend found** - returns existing record
3. `addRouteToSharedFrontend` is called:
   - Adds ACL for domain-b.com
   - Calls `uploadCertificateForSNI`:
     - Uploads `domain_b_com.pem` to `/etc/haproxy/ssl/`
4. **HAProxy now has both certificates and serves correct one via SNI**

### Important Considerations

#### 1. Certificate Naming

The certificate filename is based on `primaryDomain.replace(/[^a-zA-Z0-9]/g, "_")`. This:
- Ensures unique filenames per domain
- Avoids filesystem issues with special characters
- Example: `api.example.com` → `api_example_com.pem`

#### 2. Empty Directory Issue

HAProxy won't start if the SSL directory is empty. The current flow ensures at least one certificate exists before creating the bind (via `configureSharedFrontendSSL`).

#### 3. Certificate Updates/Renewals

When a certificate is renewed:
- The same filename is used (based on primaryDomain)
- `updateSSLCertificate` replaces the old certificate
- HAProxy picks up the new certificate automatically

#### 4. Idempotency

The `uploadCertificateForSNI` method is idempotent:
- First tries `updateSSLCertificate`
- Falls back to `uploadSSLCertificate` if not found
- Safe to call multiple times

### Testing Checklist

1. [ ] Deploy first application with SSL - verify certificate is served correctly
2. [ ] Deploy second application with different domain/certificate - verify correct certificate per domain
3. [ ] Test SNI: `openssl s_client -connect host:443 -servername domain-a.com` should show domain-a's cert
4. [ ] Test SNI: `openssl s_client -connect host:443 -servername domain-b.com` should show domain-b's cert
5. [ ] Verify HAProxy config shows `bind *:443 ssl crt /etc/haproxy/ssl/`
6. [ ] Verify both certificate files exist in `/etc/haproxy/ssl/` directory
7. [ ] Test certificate renewal - verify new cert is picked up
8. [ ] Test remediation - verify it recreates the directory-based bind correctly

### References

- [HAProxy SNI Configuration](https://serverfault.com/questions/560978/configure-multiple-ssl-certificates-in-haproxy)
- [HAProxy DataPlane API SSL Certificates](https://www.haproxy.com/documentation/haproxy-data-plane-api/tutorials/certificates/)
- [Dynamic SSL Certificate Storage](https://www.haproxy.com/blog/dynamic-ssl-certificate-storage-in-haproxy)
