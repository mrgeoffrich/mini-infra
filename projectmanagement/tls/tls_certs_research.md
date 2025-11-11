# Let's Encrypt Certificates for Containerized HAProxy: Complete Implementation Guide

DNS-01 challenges with Cloudflare and Azure DNS enable wildcard certificate provisioning for HAProxy without exposing HTTP endpoints. The landscape offers two distinct approaches: **integrated Node.js/TypeScript libraries** that embed certificate management in your application, and **containerized ACME clients** that run as separate services. Modern HAProxy 2.1+ supports Runtime API for zero-downtime certificate updates, eliminating the traditional reload penalty. For production deployments, acme-client offers the most actively maintained Node.js solution, while acme.sh provides the tightest HAProxy integration in containerized environments.

## Node.js and TypeScript ACME client libraries

### acme-client: The modern choice

The **acme-client** library (publishlab/node-acme-client) represents the most actively maintained ACME client for Node.js with full RFC 8555 compliance and TypeScript support. Unlike higher-level alternatives, it provides direct control over the certificate lifecycle while requiring manual DNS provider integration.

**Key capabilities**: Full ACME v2 protocol support, native crypto APIs for RSA and ECDSA keys, challenge priority customization, and external account binding for multiple CAs (Let's Encrypt, Buypass, Google, ZeroSSL). The `client.auto()` method simplifies the typical certificate workflow while allowing complete DNS-01 challenge customization through callback functions.

**DNS-01 implementation pattern**:

```javascript
const acme = require('acme-client');
const CloudflareAPI = require('cloudflare');

const cf = new CloudflareAPI({ token: process.env.CF_API_TOKEN });

const client = new acme.Client({
  directoryUrl: acme.directory.letsencrypt.production,
  accountKey: await acme.crypto.createPrivateKey()
});

const [certKey, certCsr] = await acme.crypto.createCsr({
  altNames: ['example.com', '*.example.com']
});

const certificate = await client.auto({
  csr: certCsr,
  email: 'admin@example.com',
  termsOfServiceAgreed: true,
  challengePriority: ['dns-01'],
  
  challengeCreateFn: async (authz, challenge, keyAuthorization) => {
    if (challenge.type === 'dns-01') {
      const domain = authz.identifier.value;
      const zones = await cf.zones.browse({ name: domain });
      
      await cf.dnsRecords.add(zones.result[0].id, {
        type: 'TXT',
        name: `_acme-challenge.${domain}`,
        content: keyAuthorization,
        ttl: 120
      });
      
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
  },
  
  challengeRemoveFn: async (authz, challenge, keyAuthorization) => {
    // Cleanup DNS records after validation
    const domain = authz.identifier.value;
    const zones = await cf.zones.browse({ name: domain });
    const records = await cf.dnsRecords.browse(zones.result[0].id, {
      type: 'TXT',
      name: `_acme-challenge.${domain}`
    });
    
    for (const record of records.result) {
      if (record.content === keyAuthorization) {
        await cf.dnsRecords.del(zones.result[0].id, record.id);
      }
    }
  }
});
```

**Cloudflare integration requirements**: Create an API token at Cloudflare Dashboard → API Tokens with permissions `Zone.Zone.Read` and `Zone.DNS.Edit` scoped to specific zones or all zones. The scoped token approach offers significantly better security than global API keys.

**Azure DNS integration with TypeScript**:

```typescript
import * as acme from 'acme-client';
import { DnsManagementClient } from '@azure/arm-dns';
import { DefaultAzureCredential } from '@azure/identity';

class AzureDnsChallengeHandler {
  private dnsClient: DnsManagementClient;
  
  constructor(subscriptionId: string, 
              private resourceGroupName: string,
              private zoneName: string) {
    const credential = new DefaultAzureCredential();
    this.dnsClient = new DnsManagementClient(credential, subscriptionId);
  }

  async create(authz: any, challenge: any, keyAuthorization: string): Promise<void> {
    if (challenge.type === 'dns-01') {
      const domain = authz.identifier.value;
      const recordName = `_acme-challenge`;
      
      await this.dnsClient.recordSets.createOrUpdate(
        this.resourceGroupName,
        this.zoneName,
        recordName,
        'TXT',
        {
          tTL: 60,
          txtRecords: [{ value: [keyAuthorization] }]
        }
      );
      
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
  }

  async remove(authz: any): Promise<void> {
    await this.dnsClient.recordSets.delete(
      this.resourceGroupName,
      this.zoneName,
      '_acme-challenge',
      'TXT'
    );
  }
}
```

**Azure authentication setup**: Create a service principal with `az ad sp create-for-rbac --name "acme-client" --role "DNS Zone Contributor" --scopes "/subscriptions/{id}/resourceGroups/{rg}"`. This generates the necessary client ID, client secret, and tenant ID. The DefaultAzureCredential automatically handles authentication from environment variables.

**Automated renewal strategy**: Implement custom scheduling logic using Node.js intervals or cron jobs. Check certificate expiration by parsing the PEM certificate and comparing the `notAfter` date. Let's Encrypt recommends renewal at 30 days before expiry.

```javascript
const fs = require('fs');
const forge = require('node-forge');

async function checkAndRenew() {
  const certPem = fs.readFileSync('./certificate.pem', 'utf8');
  const cert = forge.pki.certificateFromPem(certPem);
  const expiryDate = cert.validity.notAfter;
  const daysUntilExpiry = Math.floor((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
  
  if (daysUntilExpiry < 30) {
    console.log('Certificate expires soon, renewing...');
    // Call the certificate provisioning logic
    await renewCertificate();
  }
}

setInterval(checkAndRenew, 24 * 60 * 60 * 1000); // Check daily
```

### Greenlock.js: Plugin-based ecosystem

**Greenlock.js** provides a higher-level abstraction with a plugin architecture for DNS providers, built-in renewal management, and certificate storage backends. The ecosystem includes dedicated plugins for both Cloudflare (`acme-dns-01-cloudflare`) and Azure (`acme-dns-01-azure`), though maintenance has been moderate since 2020.

**Cloudflare DNS-01 configuration**:

```javascript
const Greenlock = require('greenlock');

const greenlock = Greenlock.create({
  packageAgent: 'my-app/1.0.0',
  configDir: './greenlock.d/',
  staging: false,
  maintainerEmail: 'admin@example.com'
});

greenlock.manager.defaults({
  subscriberEmail: 'certs@example.com',
  agreeToTerms: true,
  challenges: {
    'dns-01': {
      module: 'acme-dns-01-cloudflare',
      token: process.env.CLOUDFLARE_API_TOKEN,
      verifyPropagation: true,
      waitFor: 30000,
      retries: 5
    }
  },
  store: {
    module: 'greenlock-store-fs',
    basePath: './greenlock.d/certs'
  }
});

await greenlock.add({
  subject: 'example.com',
  altnames: ['example.com', '*.example.com']
});

// Built-in renewal runs automatically
setInterval(async () => {
  const results = await greenlock.renew();
  results.forEach(site => {
    if (site.error) {
      console.error('Renewal failed:', site.subject, site.error);
    } else {
      console.log('Renewed:', site.subject);
    }
  });
}, 6 * 60 * 60 * 1000);
```

**Azure DNS-01 configuration**:

```javascript
greenlock.manager.defaults({
  agreeToTerms: true,
  subscriberEmail: 'admin@example.com',
  challenges: {
    'dns-01': {
      module: 'acme-dns-01-azure',
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
      azureDomain: process.env.AZURE_TENANT_ID,
      TTL: 60
    }
  }
});
```

**Trade-offs**: Greenlock provides turnkey certificate management with less code, but the ecosystem hasn't received major updates since 2020. The plugin architecture limits flexibility for custom DNS provider implementations. For production systems requiring long-term maintenance, acme-client's active development cycle offers better future-proofing.

## Containerized ACME client solutions

### acme.sh: Optimal HAProxy integration

The **acme.sh** client offers the most seamless HAProxy integration through native support for stateless HTTP-01 challenges and zero-downtime certificate deployment. Written in pure shell script with minimal dependencies, it produces extremely lightweight containers (5-10MB) and includes built-in daemon mode for automated renewals.

**Container deployment with Cloudflare**:

```bash
docker run -d \
  --name acme-daemon \
  -v "/srv/acme/config:/acme.sh" \
  -v "/srv/certificates:/certs" \
  -e CF_Token="your-cloudflare-token" \
  -e CF_Zone_ID="your-zone-id" \
  neilpang/acme.sh \
  daemon
```

**Issue wildcard certificate**:

```bash
docker exec acme-daemon \
  acme.sh --issue \
  --dns dns_cf \
  -d example.com \
  -d '*.example.com'
```

**Azure DNS support**:

```bash
docker run -d \
  --name acme-daemon \
  -v "/srv/acme/config:/acme.sh" \
  -e AZUREDNS_SUBSCRIPTIONID="subscription-id" \
  -e AZUREDNS_TENANTID="tenant-id" \
  -e AZUREDNS_APPID="app-id" \
  -e AZUREDNS_CLIENTSECRET="client-secret" \
  neilpang/acme.sh \
  daemon
```

**HAProxy-specific integration**: acme.sh includes a native HAProxy deployment hook that combines certificate files correctly and can trigger graceful reloads. This eliminates manual certificate format handling.

```bash
# Configure HAProxy deploy hook
docker exec acme-daemon \
  acme.sh --issue \
  --dns dns_cf \
  -d example.com \
  --deploy-hook haproxy
```

The deploy hook automatically creates the combined PEM format (fullchain.pem + privkey.pem) required by HAProxy and places certificates in the correct directory. For containerized deployments, share volumes between acme.sh and HAProxy containers.

**Docker Compose architecture**:

```yaml
version: '3.8'

services:
  acme:
    image: neilpang/acme.sh
    command: daemon
    environment:
      - CF_Token=${CLOUDFLARE_TOKEN}
    volumes:
      - acme-data:/acme.sh
      - haproxy-certs:/certs
    restart: unless-stopped
  
  haproxy:
    image: haproxy:2.8
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
      - haproxy-certs:/etc/haproxy/certs:ro
      - haproxy-socket:/var/run/haproxy
    depends_on:
      - acme
    restart: unless-stopped

volumes:
  acme-data:
  haproxy-certs:
  haproxy-socket:
```

**Automated renewal daemon**: The daemon mode continuously monitors certificate expiration and automatically renews certificates 60 days before expiry. Configure renewal hooks to notify HAProxy of certificate updates.

### lego: Go-based simplicity

**lego** provides a single-binary ACME client written in Go with support for 80+ DNS providers. The straightforward architecture makes it ideal for cloud-native deployments where simplicity and clear error messages matter.

**Cloudflare DNS-01**:

```bash
docker run --rm \
  -v "$(pwd)/.lego:/lego" \
  -e CLOUDFLARE_DNS_API_TOKEN="your-token" \
  goacme/lego \
  --email you@example.com \
  --dns cloudflare \
  --domains example.com \
  --domains '*.example.com' \
  --path /lego \
  run
```

**Azure DNS-01**:

```bash
docker run --rm \
  -v "$(pwd)/.lego:/lego" \
  -e AZURE_CLIENT_ID="client-id" \
  -e AZURE_TENANT_ID="tenant-id" \
  -e AZURE_CLIENT_SECRET="client-secret" \
  -e AZURE_SUBSCRIPTION_ID="subscription-id" \
  -e AZURE_RESOURCE_GROUP="resource-group" \
  goacme/lego \
  --email you@example.com \
  --dns azuredns \
  --domains example.com \
  --domains '*.example.com' \
  --path /lego \
  run
```

**Automated renewal with wrapper**: The community maintains enhanced container images like `mietzen/lego-certbot` that add daemon functionality:

```yaml
services:
  lego-certbot:
    image: mietzen/lego-certbot:v4.13
    restart: always
    environment:
      - CLOUDFLARE_DNS_API_TOKEN=${CF_TOKEN}
      - EMAIL=your@email.com
      - DNS_PROVIDER=cloudflare
      - DOMAINS=example.com,*.example.com
      - dns=1.1.1.1
    volumes:
      - certs:/data
```

**Manual renewal command**:

```bash
docker run --rm \
  -v "$(pwd)/.lego:/lego" \
  -e CLOUDFLARE_DNS_API_TOKEN="token" \
  goacme/lego \
  --email you@example.com \
  --dns cloudflare \
  --domains example.com \
  --path /lego \
  renew \
  --days 60
```

### certbot: Official Let's Encrypt client

**certbot** represents the official EFF-maintained client with excellent documentation and plugin ecosystem. Separate Docker images exist for each DNS provider (`certbot/dns-cloudflare`, `certbot/dns-azure`).

**Cloudflare credentials file**:

```ini
# cloudflare.ini
dns_cloudflare_api_token = your-cloudflare-api-token
```

**Docker execution**:

```bash
docker run -it --rm \
  -v "./certs:/etc/letsencrypt" \
  -v "./cloudflare.ini:/cloudflare.ini:ro" \
  certbot/dns-cloudflare \
  certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /cloudflare.ini \
  --dns-cloudflare-propagation-seconds 20 \
  -m your@email.com \
  --agree-tos \
  --no-eff-email \
  -d example.com \
  -d '*.example.com'
```

**Azure DNS configuration**:

```ini
# azure.ini
dns_azure_msi_system_assigned = true
dns_azure_zone1 = example.com:/subscriptions/{sub-id}/resourceGroups/{rg-name}
dns_azure_environment = AzurePublicCloud
```

**Automated renewal with Docker Compose**:

```yaml
services:
  certbot:
    image: certbot/dns-cloudflare
    volumes:
      - letsencrypt:/etc/letsencrypt
      - ./cloudflare.ini:/cloudflare.ini:ro
    entrypoint: /bin/sh -c "trap exit TERM; while :; do certbot renew --dns-cloudflare --dns-cloudflare-credentials /cloudflare.ini; sleep 12h & wait $${!}; done"
```

**Certificate locations**: `/etc/letsencrypt/live/{domain}/` contains `privkey.pem` (private key), `fullchain.pem` (certificate + chain), `cert.pem` (certificate only), and `chain.pem` (chain only).

## HAProxy certificate integration specifics

### Certificate format requirements

HAProxy requires certificates in **combined PEM format** containing both the certificate chain and private key in a single file. The order matters: concatenate the full certificate chain first, followed by the private key.

**Correct format creation**:

```bash
cat /etc/letsencrypt/live/example.com/fullchain.pem \
    /etc/letsencrypt/live/example.com/privkey.pem \
    > /etc/haproxy/certs/example.com.pem

chmod 640 /etc/haproxy/certs/example.com.pem
chown haproxy:haproxy /etc/haproxy/certs/example.com.pem
```

**HAProxy configuration for directory loading**:

```conf
global
    stats socket /var/run/haproxy/admin.sock mode 660 level admin expose-fd listeners
    tune.ssl.default-dh-param 2048

frontend fe_https
    bind *:443 ssl crt /etc/haproxy/certs/ alpn h2,http/1.1 ssl-min-ver TLSv1.2
    
    # Redirect HTTP to HTTPS
    http-request redirect scheme https code 301 if !{ ssl_fc }
    
    default_backend servers
```

When pointing to a directory with `crt /etc/haproxy/certs/`, HAProxy automatically loads all `.pem` files and selects the appropriate certificate based on SNI (Server Name Indication).

**Alternative: CRT lists for complex configurations**:

```conf
# /etc/haproxy/crt-list.txt
/etc/haproxy/certs/default.pem
/etc/haproxy/certs/site.pem [alpn h2 ssl-min-ver TLSv1.2] site.local

# In configuration
frontend fe_https
    bind *:443 ssl crt-list /etc/haproxy/crt-list.txt
```

### Zero-downtime certificate updates with Runtime API

HAProxy 2.1+ introduces a Runtime API that enables **certificate updates without any reload**, eliminating memory spikes and ensuring true zero-downtime operations. This represents a significant advancement over traditional reload mechanisms.

**Enable Runtime API**:

```conf
global
    stats socket /var/run/haproxy/admin.sock mode 660 level admin expose-fd listeners
```

**Update certificate via socat**:

```bash
#!/bin/bash
CERT_PATH="/etc/haproxy/certs"
SOCK="/var/run/haproxy/admin.sock"
DOMAIN="example.com"

# Combine new certificate files
cat fullchain.pem privkey.pem > new-cert.pem

# Set new certificate (transaction)
echo "set ssl cert $CERT_PATH/${DOMAIN}.pem <<" | socat stdio unix-connect:$SOCK
cat new-cert.pem | socat stdio unix-connect:$SOCK
echo "" | socat stdio unix-connect:$SOCK

# Commit changes (activates immediately)
echo "commit ssl cert $CERT_PATH/${DOMAIN}.pem" | socat stdio unix-connect:$SOCK

# Copy to disk for persistence
cp new-cert.pem $CERT_PATH/${DOMAIN}.pem
```

**Important consideration**: Runtime API updates occur in-memory only. Always persist the certificate to disk after updating through the API to ensure the change survives HAProxy restarts.

**Verification commands**:

```bash
# List all certificates
echo "show ssl cert" | socat stdio unix-connect:/var/run/haproxy/admin.sock

# Show specific certificate details
echo "show ssl cert /etc/haproxy/certs/example.com.pem" | socat stdio unix-connect:/var/run/haproxy/admin.sock
```

### Graceful reload for older versions

HAProxy 1.8+ with Linux kernel 3.9+ supports zero-downtime reloads through socket transfer using the `expose-fd listeners` option.

**Reload command**:

```bash
# Systemd
systemctl reload haproxy

# Manual with socket transfer
haproxy -f /etc/haproxy/haproxy.cfg \
        -p /run/haproxy.pid \
        -x /run/haproxy/admin.sock \
        -sf $(cat /run/haproxy.pid)
```

**Docker container reload**:

```bash
# Send USR2 signal for graceful reload
docker kill -s USR2 haproxy_container

# Or via docker-compose
docker-compose exec haproxy kill -USR2 1
```

The old process continues serving existing connections while the new process accepts new connections. Socket file descriptors transfer to the new process, preventing any dropped connections.

### Post-renewal certificate deployment

**Automated deployment script for certbot**:

```bash
#!/bin/bash
# /etc/letsencrypt/renewal-hooks/deploy/haproxy-update.sh

DOMAIN="$RENEWED_DOMAINS"
CERT_PATH="/etc/letsencrypt/live/$DOMAIN"
HAPROXY_CERTS="/etc/haproxy/certs"

# Combine for HAProxy
cat "$CERT_PATH/fullchain.pem" "$CERT_PATH/privkey.pem" > /tmp/combined.pem

# Update via Runtime API (HAProxy 2.1+)
echo -e "set ssl cert $HAPROXY_CERTS/$DOMAIN.pem <<\n$(cat /tmp/combined.pem)\n" | \
    socat unix-connect:/var/run/haproxy/admin.sock -

echo "commit ssl cert $HAPROXY_CERTS/$DOMAIN.pem" | \
    socat unix-connect:/var/run/haproxy/admin.sock -

# Copy to disk for persistence
cp /tmp/combined.pem $HAPROXY_CERTS/$DOMAIN.pem
chmod 640 $HAPROXY_CERTS/$DOMAIN.pem
chown haproxy:haproxy $HAPROXY_CERTS/$DOMAIN.pem

rm /tmp/combined.pem

# Optional: Reload if Runtime API unavailable
# systemctl reload haproxy
```

```bash
chmod +x /etc/letsencrypt/renewal-hooks/deploy/haproxy-update.sh
```

**acme.sh native HAProxy hook**:

```bash
DEPLOY_HAPROXY_HOT_UPDATE=yes \
DEPLOY_HAPROXY_STATS_SOCKET=/var/run/haproxy/admin.sock \
DEPLOY_HAPROXY_PEM_PATH=/etc/haproxy/certs \
acme.sh --deploy -d example.com --deploy-hook haproxy
```

The acme.sh HAProxy hook automatically handles certificate formatting and can trigger Runtime API updates or graceful reloads.

## DNS-01 challenge implementation details

### Understanding DNS-01 challenges

The DNS-01 challenge proves domain ownership by creating specific TXT records in DNS. Let's Encrypt requests a token, and your ACME client creates a TXT record at `_acme-challenge.yourdomain.com` with a derived value. The CA validates this record from multiple locations before issuing the certificate.

**Why DNS-01 for this architecture**:

- **Wildcard certificates**: DNS-01 is the only ACME challenge type supporting `*.example.com` certificates
- **No HTTP exposure required**: Works for internal services, private networks, or when port 80 is unavailable
- **Centralized management**: DNS API access from a single Node.js application enables certificate provisioning for multiple services
- **Better security**: HAProxy doesn't need to handle ACME HTTP challenges or expose special endpoints

**Trade-offs**: DNS-01 requires DNS provider API access (increasing credential risk), involves DNS propagation delays (20-60 seconds), and proves more complex than HTTP-01 challenges.

### Cloudflare DNS API integration

**API Token creation** (recommended over global API keys):

1. Navigate to Cloudflare Dashboard → Profile → API Tokens
2. Create Custom Token with permissions:
   - Zone → Zone → Read
   - Zone → DNS → Edit
3. Scope to specific zones or all zones
4. Note: Zone listing requires Zone.Read on all zones

**Rate limits**: Cloudflare allows approximately 1200 API requests per 5 minutes. Standard certificate operations consume minimal quota. Blocked TLDs include .cf, .ga, .gq, .ml, and .tk.

**DNS record manipulation**:

```javascript
// Create TXT record for ACME challenge
const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    type: 'TXT',
    name: `_acme-challenge.${domain}`,
    content: keyAuthorization,
    ttl: 120  // 2 minutes
  })
});

// Wait for DNS propagation
await new Promise(resolve => setTimeout(resolve, 30000));

// Delete record after validation
await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`, {
  method: 'DELETE',
  headers: { 'Authorization': `Bearer ${apiToken}` }
});
```

**Best practices**: Use scoped API tokens with minimal required permissions, implement token rotation quarterly, wait 20-60 seconds for DNS propagation before ACME validation, and monitor API usage to avoid rate limits.

### Azure DNS API integration

Azure supports four authentication methods with varying security and complexity trade-offs.

**Service Principal (recommended for Docker/VM deployments)**:

```bash
# Create service principal
az ad sp create-for-rbac --name "acme-dns-client" \
  --role "DNS Zone Contributor" \
  --scopes "/subscriptions/{subscription-id}/resourceGroups/{resource-group}"

# Output provides:
# - appId (client ID)
# - password (client secret)
# - tenant (tenant ID)
```

**Environment variables**:

```bash
export AZURE_CLIENT_ID="app-id"
export AZURE_CLIENT_SECRET="client-secret"
export AZURE_TENANT_ID="tenant-id"
export AZURE_SUBSCRIPTION_ID="subscription-id"
```

**Workload Identity (recommended for AKS)**:

```bash
# Enable on cluster
az aks update --name my-cluster \
  --enable-oidc-issuer \
  --enable-workload-identity

# Create managed identity
az identity create --name cert-manager-identity \
  --resource-group my-rg

IDENTITY_CLIENT_ID=$(az identity show \
  --name cert-manager-identity \
  --resource-group my-rg \
  --query 'clientId' -o tsv)

# Grant DNS permissions
az role assignment create \
  --role "DNS Zone Contributor" \
  --assignee $IDENTITY_CLIENT_ID \
  --scope $(az network dns zone show \
    --name example.com \
    --resource-group dns-rg \
    -o tsv --query id)

# Create federated credential
SERVICE_ACCOUNT_ISSUER=$(az aks show \
  --name my-cluster \
  --resource-group my-rg \
  --query "oidcIssuerProfile.issuerUrl" -o tsv)

az identity federated-credential create \
  --name cert-manager-federated-identity \
  --identity-name cert-manager-identity \
  --resource-group my-rg \
  --issuer $SERVICE_ACCOUNT_ISSUER \
  --subject system:serviceaccount:cert-manager:cert-manager
```

Workload Identity eliminates secret management by using Kubernetes service account token projection for authentication, representing the most secure Azure authentication method.

**Required RBAC role**: `DNS Zone Contributor` provides the minimum permissions needed for ACME DNS-01 challenges (create, read, update, delete TXT records).

**DNS record creation with Azure SDK**:

```typescript
import { DnsManagementClient } from '@azure/arm-dns';
import { DefaultAzureCredential } from '@azure/identity';

const credential = new DefaultAzureCredential();
const client = new DnsManagementClient(credential, subscriptionId);

await client.recordSets.createOrUpdate(
  resourceGroupName,
  zoneName,
  '_acme-challenge',
  'TXT',
  {
    tTL: 60,
    txtRecords: [{ value: [keyAuthorization] }]
  }
);

// Wait for propagation
await new Promise(resolve => setTimeout(resolve, 30000));

// Cleanup after validation
await client.recordSets.delete(
  resourceGroupName,
  zoneName,
  '_acme-challenge',
  'TXT'
);
```

## Architecture patterns for containerized environments

### Pattern A: Sidecar containers

The sidecar pattern couples the ACME client with HAProxy in the same pod or docker-compose service group, sharing certificate volumes through emptyDir (Kubernetes) or named volumes (Docker).

**Docker Compose implementation**:

```yaml
version: '3.8'

services:
  haproxy:
    image: haproxy:2.8
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
      - certs:/etc/haproxy/certs:ro
    restart: unless-stopped
  
  certbot:
    image: certbot/dns-cloudflare
    volumes:
      - certs:/etc/letsencrypt
      - ./cloudflare.ini:/cloudflare.ini:ro
    environment:
      - CF_DNS_API_TOKEN
    command: sh -c "trap exit TERM; while :; do certbot renew --dns-cloudflare --dns-cloudflare-credentials /cloudflare.ini --deploy-hook '/update-haproxy.sh'; sleep 12h & wait $${!}; done"

volumes:
  certs:
```

**Kubernetes sidecar**:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: haproxy-with-certbot
spec:
  containers:
  - name: haproxy
    image: haproxy:2.8
    volumeMounts:
    - name: certs
      mountPath: /etc/haproxy/certs
      readOnly: true
  
  - name: certbot
    image: certbot/dns-cloudflare
    volumeMounts:
    - name: certs
      mountPath: /etc/letsencrypt
    env:
    - name: CF_DNS_API_TOKEN
      valueFrom:
        secretKeyRef:
          name: cloudflare-token
          key: token
  
  volumes:
  - name: certs
    emptyDir: {}
```

**When to use**: Single-service deployments, development environments, or simple architectures where certificate management couples tightly with a specific service. The sidecar pattern simplifies networking (localhost communication) and lifecycle management (containers start/stop together).

**Limitations**: Resource overhead per pod, poor horizontal scaling, restart of cert container affects entire pod, certificate duplication across multiple replicas.

### Pattern B: Centralized certificate service

Production architectures benefit from separating certificate management into a dedicated service that provisions certificates for multiple HAProxy instances or other services.

**cert-manager architecture (Kubernetes)**:

```yaml
# Install cert-manager
# helm install cert-manager jetstack/cert-manager --namespace cert-manager --create-namespace --set installCRDs=true

# Cloudflare API token secret
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token
  namespace: cert-manager
type: Opaque
stringData:
  api-token: your-cloudflare-token

---
# ClusterIssuer for DNS-01
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@example.com
    privateKeySecretRef:
      name: letsencrypt-account-key
    solvers:
    - dns01:
        cloudflare:
          apiTokenSecretRef:
            name: cloudflare-api-token
            key: api-token

---
# Certificate resource
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-cert
  namespace: default
spec:
  secretName: wildcard-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
  - example.com
  - '*.example.com'
  renewBefore: 720h  # Renew 30 days before expiry

---
# HAProxy deployment using certificate
apiVersion: apps/v1
kind: Deployment
metadata:
  name: haproxy
spec:
  replicas: 3
  selector:
    matchLabels:
      app: haproxy
  template:
    metadata:
      labels:
        app: haproxy
    spec:
      containers:
      - name: haproxy
        image: haproxy:2.8
        volumeMounts:
        - name: certs
          mountPath: /etc/haproxy/certs
          readOnly: true
      volumes:
      - name: certs
        secret:
          secretName: wildcard-tls
```

cert-manager automatically handles certificate provisioning, renewal, and updates the Kubernetes secret. HAProxy deployments mount this secret and automatically receive updated certificates through Kubernetes secret updates.

**Docker Compose centralized service**:

```yaml
version: '3.8'

services:
  cert-manager:
    image: neilpang/acme.sh
    command: daemon
    environment:
      - CF_Token=${CLOUDFLARE_TOKEN}
      - AZUREDNS_SUBSCRIPTIONID=${AZURE_SUBSCRIPTION_ID}
      - AZUREDNS_TENANTID=${AZURE_TENANT_ID}
      - AZUREDNS_APPID=${AZURE_CLIENT_ID}
      - AZUREDNS_CLIENTSECRET=${AZURE_CLIENT_SECRET}
    volumes:
      - acme-data:/acme.sh
      - shared-certs:/certs
    restart: unless-stopped
  
  haproxy-1:
    image: haproxy:2.8
    volumes:
      - shared-certs:/etc/haproxy/certs:ro
      - ./haproxy-1.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
    ports:
      - "443:443"
  
  haproxy-2:
    image: haproxy:2.8
    volumes:
      - shared-certs:/etc/haproxy/certs:ro
      - ./haproxy-2.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
    ports:
      - "8443:443"
  
  nodejs-app:
    build: ./app
    volumes:
      - shared-certs:/app/certs:ro

volumes:
  acme-data:
  shared-certs:
```

**When to use**: Multiple services need certificates, horizontal scaling required, centralized security and compliance management, or when certificate operations should be independent of application deployments.

**Benefits**: Single renewal operation serves all services, independent scaling, centralized monitoring, reduced API calls, and simplified certificate updates.

### Volume sharing strategies

**ReadWriteMany for Kubernetes**:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: cert-storage
spec:
  accessModes:
  - ReadWriteMany  # Critical for multi-pod access
  storageClassName: nfs-client  # or azure-file, efs-csi
  resources:
    requests:
      storage: 1Gi
```

ReadWriteMany access mode enables multiple HAProxy pods to read the same certificate volume simultaneously. Supported storage classes include NFS, Azure Files, AWS EFS, and GlusterFS.

**Init containers for certificate preparation**:

```yaml
spec:
  initContainers:
  - name: cert-combiner
    image: alpine
    command:
    - sh
    - -c
    - |
      cat /source/tls.crt /source/tls.key > /dest/combined.pem
      chmod 600 /dest/combined.pem
    volumeMounts:
    - name: source-certs
      mountPath: /source
      readOnly: true
    - name: haproxy-certs
      mountPath: /dest
  
  containers:
  - name: haproxy
    volumeMounts:
    - name: haproxy-certs
      mountPath: /etc/haproxy/certs
      readOnly: true
```

Init containers prepare certificates in HAProxy's required format before the main container starts, ensuring proper formatting without runtime dependencies.

## Automated renewal and monitoring

### Renewal timing strategies

Let's Encrypt certificates expire after 90 days. **Recommended renewal window**: 30 days before expiry provides sufficient buffer for failures and retries while avoiding excessive API calls.

**Cron-based renewal (Docker/VM)**:

```bash
#!/bin/bash
# /usr/local/bin/cert-renewal.sh

LOG_FILE="/var/log/cert-renewal.log"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "Starting certificate renewal check"

# Run renewal
if certbot renew --dns-cloudflare --dns-cloudflare-credentials /etc/cloudflare.ini --deploy-hook /usr/local/bin/update-haproxy.sh; then
    log "Renewal successful"
    # Send success webhook
    curl -X POST https://monitoring.example.com/webhook \
         -H "Content-Type: application/json" \
         -d '{"status":"success","timestamp":"'"$(date -Iseconds)"'"}'
else
    log "ERROR: Renewal failed"
    # Send failure alert
    curl -X POST https://monitoring.example.com/webhook \
         -H "Content-Type: application/json" \
         -d '{"status":"failed","timestamp":"'"$(date -Iseconds)"'","severity":"critical"}'
    exit 1
fi
```

**Crontab entry**:

```cron
# Check for renewal twice daily at 2:17 AM and 2:17 PM
17 2,14 * * * /usr/local/bin/cert-renewal.sh
```

**Kubernetes CronJob**:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cert-renewal
spec:
  schedule: "0 2 * * *"  # 2 AM daily
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: cert-manager
          containers:
          - name: certbot
            image: certbot/dns-cloudflare
            env:
            - name: CF_DNS_API_TOKEN
              valueFrom:
                secretKeyRef:
                  name: cloudflare-token
                  key: token
            command:
            - /bin/sh
            - -c
            - |
              set -e
              certbot renew --dns-cloudflare --dns-cloudflare-credentials /cloudflare.ini
              
              # Update Kubernetes secret
              kubectl create secret tls wildcard-cert \
                --cert=/etc/letsencrypt/live/example.com/fullchain.pem \
                --key=/etc/letsencrypt/live/example.com/privkey.pem \
                --dry-run=client -o yaml | kubectl apply -f -
            volumeMounts:
            - name: cloudflare-credentials
              mountPath: /cloudflare.ini
              subPath: cloudflare.ini
            - name: certs
              mountPath: /etc/letsencrypt
          volumes:
          - name: cloudflare-credentials
            secret:
              secretName: cloudflare-credentials
          - name: certs
            persistentVolumeClaim:
              claimName: cert-storage
          restartPolicy: OnFailure
```

**cert-manager automatic renewal**: When using cert-manager, the controller automatically monitors certificate expiration and triggers renewal based on the `renewBefore` specification (default: 30 days before expiry). No manual configuration required.

### Certificate expiration monitoring

**Python monitoring script**:

```python
#!/usr/bin/env python3
import ssl
import socket
from datetime import datetime
import requests
import sys

def check_cert_expiry(hostname, port=443):
    """Check certificate expiration for a hostname"""
    try:
        context = ssl.create_default_context()
        with socket.create_connection((hostname, port), timeout=10) as sock:
            with context.wrap_socket(sock, server_hostname=hostname) as ssock:
                cert = ssock.getpeercert()
                expiry = datetime.strptime(cert['notAfter'], '%b %d %H:%M:%S %Y %Z')
                days_left = (expiry - datetime.utcnow()).days
                
                print(f"{hostname}: {days_left} days until expiry")
                
                # Alert thresholds
                if days_left < 7:
                    send_alert(hostname, days_left, "critical")
                    return 2
                elif days_left < 14:
                    send_alert(hostname, days_left, "warning")
                    return 1
                elif days_left < 30:
                    send_alert(hostname, days_left, "info")
                
                return 0
                
    except Exception as e:
        print(f"ERROR checking {hostname}: {e}")
        send_alert(hostname, None, "error", str(e))
        return 3

def send_alert(hostname, days_left, severity, error=None):
    """Send alert to monitoring system"""
    payload = {
        "hostname": hostname,
        "days_until_expiry": days_left,
        "severity": severity,
        "timestamp": datetime.utcnow().isoformat(),
    }
    if error:
        payload["error"] = error
    
    try:
        requests.post(
            "https://monitoring.example.com/alerts",
            json=payload,
            timeout=10
        )
    except Exception as e:
        print(f"Failed to send alert: {e}")

if __name__ == "__main__":
    domains = [
        "example.com",
        "www.example.com",
        "api.example.com"
    ]
    
    max_exit_code = 0
    for domain in domains:
        exit_code = check_cert_expiry(domain)
        max_exit_code = max(max_exit_code, exit_code)
    
    sys.exit(max_exit_code)
```

**Prometheus metrics with cert-manager**:

cert-manager exposes Prometheus metrics on port 9402:

- `certmanager_certificate_expiration_timestamp_seconds`: Unix timestamp when certificate expires
- `certmanager_certificate_ready_status`: Certificate readiness status (1 = ready, 0 = not ready)
- `certmanager_certificate_renewal_timestamp_seconds`: Last successful renewal timestamp

**Alerting rules**:

```yaml
groups:
- name: certificates
  interval: 1h
  rules:
  - alert: CertificateExpiringSoon
    expr: (certmanager_certificate_expiration_timestamp_seconds - time()) < 604800
    labels:
      severity: warning
    annotations:
      summary: "Certificate {{ $labels.name }} expires in less than 7 days"
      description: "Certificate in namespace {{ $labels.namespace }} will expire on {{ $value | humanizeTimestamp }}"
  
  - alert: CertificateExpiryCritical
    expr: (certmanager_certificate_expiration_timestamp_seconds - time()) < 172800
    labels:
      severity: critical
    annotations:
      summary: "CRITICAL: Certificate {{ $labels.name }} expires in less than 2 days"
  
  - alert: CertificateRenewalFailed
    expr: certmanager_certificate_ready_status{condition="False"} == 1
    for: 1h
    labels:
      severity: critical
    annotations:
      summary: "Certificate {{ $labels.name }} renewal failed"
      description: "cert-manager failed to renew certificate in namespace {{ $labels.namespace }}"
```

**Health check endpoint for Node.js app**:

```javascript
const express = require('express');
const { execSync } = require('child_process');
const forge = require('node-forge');
const fs = require('fs');

const app = express();

app.get('/health/certificates', (req, res) => {
  try {
    const certPath = '/etc/haproxy/certs/example.com.pem';
    const certPem = fs.readFileSync(certPath, 'utf8');
    const cert = forge.pki.certificateFromPem(certPem);
    
    const expiryDate = cert.validity.notAfter;
    const now = new Date();
    const daysUntilExpiry = Math.floor((expiryDate - now) / (1000 * 60 * 60 * 24));
    
    const status = {
      healthy: daysUntilExpiry > 7,
      certificates: [{
        path: certPath,
        daysUntilExpiry: daysUntilExpiry,
        expiryDate: expiryDate.toISOString(),
        subject: cert.subject.getField('CN').value
      }]
    };
    
    const httpStatus = status.healthy ? 200 : 503;
    res.status(httpStatus).json(status);
    
  } catch (error) {
    res.status(500).json({
      healthy: false,
      error: error.message
    });
  }
});

app.listen(8080);
```

## Comparison and recommendations

### Solution comparison matrix

| Aspect | acme-client (Node.js) | Greenlock.js | acme.sh (Container) | lego (Container) | certbot (Container) |
|--------|----------------------|--------------|---------------------|------------------|---------------------|
| **Maintenance** | ✅ Active (2024) | ⚠️ Moderate (2020) | ✅ Active | ✅ Active | ✅ Active |
| **Integration Style** | Embedded library | Embedded library | Separate service | Separate service | Separate service |
| **Image Size** | N/A (library) | N/A (library) | 5-10MB | ~30MB | ~200MB |
| **HAProxy Integration** | Manual | Manual | ✅ Native | Manual | Manual |
| **DNS-01 Support** | ✅ Manual implementation | ✅ Plugin-based | ✅ 100+ providers | ✅ 80+ providers | ✅ 50+ providers |
| **Cloudflare** | DIY | ✅ Plugin | ✅ Built-in | ✅ Built-in | ✅ Built-in |
| **Azure DNS** | DIY | ✅ Plugin | ✅ Built-in | ✅ Built-in | ✅ Built-in |
| **TypeScript** | ✅ Excellent | ⚠️ Limited | N/A | N/A | N/A |
| **Auto Renewal** | DIY | ✅ Built-in | ✅ Daemon mode | External cron | External cron |
| **Learning Curve** | Medium | Easy | Low | Low | Low |
| **Flexibility** | High | Medium | Medium | Medium | Medium |

### Architectural decision framework

**Choose Node.js library (acme-client) when**:
- Certificate management needs tight integration with application logic
- You need programmatic control over certificate lifecycle events
- TypeScript type safety is important
- The application already manages HAProxy configuration dynamically
- You want to minimize container count

**Choose containerized solution (acme.sh, lego, certbot) when**:
- Certificate management should be independent of application code
- Multiple services or HAProxy instances need certificates
- Operations team prefers standard tooling
- You want battle-tested, widely-deployed solutions
- Horizontal scaling requires shared certificate storage

**For Cloudflare DNS specifically**:
- All solutions provide excellent Cloudflare support
- acme.sh and lego offer the simplest configuration
- Use API tokens with Zone:DNS:Edit + Zone:Zone:Read permissions
- Expect 20-30 second DNS propagation times

**For Azure DNS specifically**:
- All solutions support Azure, but with varying authentication complexity
- Workload Identity (AKS) provides best security
- Service Principal works for Docker/VM deployments
- Ensure DNS Zone Contributor role assignment

### Production architecture recommendations

**Small deployment (1-3 HAProxy instances)**:

```yaml
# Docker Compose with acme.sh
version: '3.8'
services:
  acme:
    image: neilpang/acme.sh
    command: daemon
    environment:
      - CF_Token=${CLOUDFLARE_TOKEN}
    volumes:
      - acme-data:/acme.sh
      - certs:/certs
  
  haproxy:
    image: haproxy:2.8
    volumes:
      - certs:/etc/haproxy/certs:ro
      - ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
    ports:
      - "443:443"

volumes:
  acme-data:
  certs:
```

**Medium deployment (3-10 HAProxy instances, Kubernetes)**:

Use **cert-manager** with ClusterIssuer, mounting certificates as Kubernetes secrets. cert-manager handles all renewal automatically and updates secrets transparently.

**Large/enterprise deployment**:

Combine cert-manager with external secret store (HashiCorp Vault, Azure Key Vault) for enhanced security. Use separate namespaces for certificate management and application workloads. Implement comprehensive Prometheus monitoring with PagerDuty/Opsgenie integration.

**Node.js application managing HAProxy**:

If your Node.js application already dynamically configures HAProxy, embedding acme-client provides the tightest integration:

```javascript
const acme = require('acme-client');
const fs = require('fs').promises;

class CertificateManager {
  constructor(dnsProvider) {
    this.dnsProvider = dnsProvider;
    this.client = new acme.Client({
      directoryUrl: acme.directory.letsencrypt.production,
      accountKey: accountPrivateKey
    });
  }
  
  async provisionCertificate(domains) {
    const [key, csr] = await acme.crypto.createCsr({ altNames: domains });
    
    const cert = await this.client.auto({
      csr,
      email: 'admin@example.com',
      termsOfServiceAgreed: true,
      challengePriority: ['dns-01'],
      challengeCreateFn: (authz, challenge, keyAuth) => 
        this.dnsProvider.createRecord(authz.identifier.value, keyAuth),
      challengeRemoveFn: (authz, challenge, keyAuth) =>
        this.dnsProvider.removeRecord(authz.identifier.value, keyAuth)
    });
    
    // Combine for HAProxy
    const combined = cert + key;
    await fs.writeFile(`/etc/haproxy/certs/${domains[0]}.pem`, combined);
    
    // Update HAProxy via Runtime API
    await this.updateHAProxy(domains[0], combined);
    
    return { certificate: cert, privateKey: key };
  }
  
  async updateHAProxy(domain, combinedPem) {
    // Implement Runtime API update
    const sock = '/var/run/haproxy/admin.sock';
    // Execute socat commands or use Node.js socket
  }
}
```

### Security best practices summary

**Credential management**:
- Store API tokens in environment variables or secret managers (never in code)
- Use scoped tokens with minimum required permissions
- Rotate credentials quarterly
- Implement Kubernetes Secrets with encryption at rest
- Consider external secret stores (Vault, Key Vault) for production

**Certificate handling**:
- Set file permissions to 600 or 640 on private keys
- Use separate directories for different certificate types
- Implement file locking if multiple processes access certificates
- Regularly audit certificate access logs

**Monitoring and alerting**:
- Alert at 30, 14, 7, and 2 days before expiry
- Monitor renewal success/failure
- Track ACME API rate limits
- Log all certificate operations
- Implement health check endpoints

**Network security**:
- Restrict DNS API access to specific services
- Use firewall rules to limit outbound connections
- Implement network policies in Kubernetes
- Monitor DNS query patterns for anomalies

This architecture provides production-ready, secure, and scalable Let's Encrypt certificate management for containerized HAProxy environments with comprehensive DNS-01 challenge support for both Cloudflare and Azure DNS.