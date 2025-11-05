# DNS and HAProxy Frontend Routing

## Overview

This feature provides automatic DNS record management and HAProxy frontend configuration for deployments, enabling hostname-based routing to containerized applications with zero-downtime deployments.

When you deploy an application with a hostname, the system automatically:

1. **Creates an HAProxy Frontend** with hostname-based routing rules
2. **Configures DNS Records** (for local network environments) in CloudFlare
3. **Routes traffic** from the hostname to the correct application backend
4. **Cleans up resources** when the deployment is removed

## Key Features

- ✅ **Automatic DNS Management** - Creates and removes DNS A records in CloudFlare
- ✅ **Hostname-Based Routing** - HAProxy routes traffic based on HTTP Host header
- ✅ **Zero-Downtime Deployments** - Seamless blue-green deployments maintain DNS records
- ✅ **Multi-Environment Support** - Local and internet network types
- ✅ **Error Handling** - Graceful handling of DNS and frontend failures
- ✅ **Manual Sync** - Manual DNS and frontend synchronization options
- ✅ **Status Tracking** - Real-time status of DNS and frontend configurations

## Architecture

### Components

```
┌─────────────────┐
│   User Request  │
└────────┬────────┘
         │
         v
┌─────────────────┐     ┌─────────────────┐
│  DNS (CloudFlare)│────>│   HAProxy       │
│  A Record        │     │   Frontend      │
└─────────────────┘     └────────┬────────┘
                                 │
                      ┌──────────┴──────────┐
                      │  HAProxy Backend    │
                      │  (with servers)     │
                      └──────────┬──────────┘
                                 │
                      ┌──────────┴──────────┐
                      │  Application        │
                      │  Container(s)       │
                      └─────────────────────┘
```

### Data Flow

1. **Deployment Configuration Created**
   - User specifies hostname (e.g., `api.example.com`)
   - Environment network type determines DNS behavior

2. **Deployment Triggered**
   - State machine executes deployment steps
   - After health checks pass:
     - Create HAProxy frontend with hostname routing
     - Create DNS A record (if local network type)

3. **Traffic Routing**
   - DNS resolves hostname to Docker host IP
   - HAProxy receives request on port 80
   - HAProxy matches Host header to ACL
   - HAProxy routes to correct backend
   - Backend forwards to application container

4. **Deployment Removal**
   - State machine executes removal steps
   - Remove HAProxy frontend
   - Remove DNS A record
   - Clean up database records

## Configuration

### Environment Network Types

The environment's `networkType` field determines DNS behavior:

- **`local`** - Creates DNS records automatically
  - Use for: Development, staging, internal applications
  - DNS points to Docker host private/public IP
  - Requires CloudFlare configuration

- **`internet`** - Skips DNS record creation
  - Use for: Production with external DNS management
  - Assumes DNS is managed outside the system
  - Only creates HAProxy frontend

### System Settings

#### CloudFlare Configuration

Navigate to: **Settings → System → CloudFlare**

Required settings:
- **API Token** - CloudFlare API token with DNS edit permissions
- **Zone ID** (optional) - Specific zone to use, or auto-detect

To create a CloudFlare API token:
1. Log into CloudFlare dashboard
2. Go to: My Profile → API Tokens
3. Create Token → Edit zone DNS template
4. Select zones: Include → Specific zone → your zone(s)
5. Permissions: Zone → DNS → Edit
6. Copy token and paste into system settings

#### Docker Host Configuration

Navigate to: **Settings → System → Docker**

Optional settings:
- **Docker Host IP** - Override auto-detected IP for DNS records
  - Leave empty for auto-detection
  - Set to external IP if Docker host is internet-accessible
  - Set to private IP if Docker host is on local network

### Deployment Configuration

When creating a deployment configuration:

```typescript
{
  "applicationName": "myapp",
  "hostname": "api.example.com",  // ← Hostname for routing
  "environmentId": "env_123",     // ← Environment determines DNS behavior
  "image": "myapp:latest",
  "containerPort": 3000,
  "replicas": 1
}
```

**Hostname Requirements:**
- Must be a valid domain name
- Must include TLD (e.g., `.com`, `.io`)
- Zone must exist in CloudFlare (for local networks)
- Example valid hostnames:
  - `api.example.com`
  - `web.mycompany.io`
  - `staging-app.example.org`

## Usage

### Creating a Deployment with DNS and Frontend

1. **Create Environment**
   ```bash
   POST /api/environments
   {
     "name": "staging",
     "networkType": "local",
     "description": "Staging environment"
   }
   ```

2. **Create Deployment Configuration**
   ```bash
   POST /api/deployments/configs
   {
     "applicationName": "myapp",
     "hostname": "myapp-staging.example.com",
     "environmentId": "env_abc123",
     "image": "myapp:v1.0",
     "containerPort": 3000,
     "replicas": 2
   }
   ```

3. **Trigger Deployment**
   ```bash
   POST /api/deployments/configs/{configId}/deploy
   {
     "deploymentStrategy": "initial"
   }
   ```

4. **Monitor Deployment**
   - Watch deployment progress in UI
   - Check logs: `tail -f server/logs/app-deployments.log`
   - Verify frontend status: `GET /api/deployments/configs/{configId}/frontend`
   - Verify DNS status: `GET /api/deployments/configs/{configId}/dns`

5. **Test Access**
   ```bash
   # Wait for DNS propagation (30s - 5min)
   nslookup myapp-staging.example.com

   # Test application access
   curl http://myapp-staging.example.com
   ```

### Blue-Green Deployment

Blue-green deployments automatically update the frontend but maintain DNS records:

```bash
# Trigger blue-green deployment
POST /api/deployments/configs/{configId}/deploy
{
  "deploymentStrategy": "bluegreen"
}
```

**What Happens:**
1. Green container starts
2. Green backend created in HAProxy
3. Green health checks run
4. Frontend **updated** to route to green backend (not recreated)
5. DNS remains unchanged (same hostname → same IP)
6. Traffic smoothly transitions to green
7. Blue drained and removed

**Result:** Zero-downtime deployment with stable DNS.

### Removing a Deployment

```bash
DELETE /api/deployments/configs/{configId}
```

**Cleanup Process:**
1. Remove from HAProxy backend
2. Remove HAProxy frontend
3. Remove DNS A record (if created)
4. Stop and remove containers
5. Clean up database records

All resources are automatically cleaned up.

### Manual Sync Operations

#### Sync DNS Record

If DNS record is out of sync or failed:

```bash
# Via API
POST /api/deployments/configs/{configId}/dns/sync

# Via UI
Navigate to deployment details → Click "Sync DNS" button
```

This will:
- Recreate DNS record if missing
- Update IP address if changed
- Update status to active

#### Sync Frontend

If frontend configuration is out of sync:

```bash
# Via API
POST /api/deployments/configs/{configId}/frontend/sync

# Via UI
Navigate to deployment details → Click "Sync Frontend" button
```

This will:
- Recreate frontend if missing
- Update ACL and routing rules
- Update status to active

## State Machine Integration

DNS and frontend configuration are integrated into deployment state machines:

### Initial Deployment State Machine

```
[States]
├── starting
├── creatingApplication
├── waitingForContainers
├── registeringWithLB
├── performingHealthChecks
├── configuringFrontend          ← NEW
├── configuringDNS               ← NEW
├── enablingTraffic
└── completed

[Events]
├── FRONTEND_CONFIGURED          ← NEW
├── FRONTEND_CONFIG_ERROR        ← NEW
├── DNS_CONFIGURED               ← NEW
├── DNS_CONFIG_SKIPPED           ← NEW
└── DNS_CONFIG_ERROR             ← NEW
```

### Blue-Green Deployment State Machine

```
[States]
├── starting
├── creatingGreenApplication
├── waitingForGreenContainers
├── registeringGreenWithLB
├── performingGreenHealthChecks
├── configuringGreenFrontend     ← NEW
├── configuringDNS               ← NEW (updates if needed)
├── openingTrafficToGreen
├── drainingBlue
└── completed
```

### Removal Deployment State Machine

```
[States]
├── starting
├── removingFromLB
├── removingFrontend             ← NEW
├── removingDNS                  ← NEW
├── stoppingApplication
└── completed
```

## Database Schema

### DeploymentDNSRecord

Tracks DNS records created for deployments.

```sql
CREATE TABLE deployment_dns_records (
  id TEXT PRIMARY KEY,
  deploymentConfigId TEXT NOT NULL,
  hostname TEXT NOT NULL,
  dnsProvider TEXT NOT NULL,       -- 'cloudflare', 'external'
  dnsRecordId TEXT,                 -- Provider's record ID
  ipAddress TEXT,                   -- IP in DNS record
  zoneId TEXT,                      -- CloudFlare zone ID
  zoneName TEXT,                    -- CloudFlare zone name
  status TEXT DEFAULT 'pending',    -- 'active', 'pending', 'failed', 'removed'
  errorMessage TEXT,                -- Error details if failed
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (deploymentConfigId) REFERENCES deployment_configurations(id)
);

CREATE INDEX idx_dns_deploymentConfigId ON deployment_dns_records(deploymentConfigId);
CREATE INDEX idx_dns_hostname ON deployment_dns_records(hostname);
CREATE INDEX idx_dns_status ON deployment_dns_records(status);
```

### HAProxyFrontend

Tracks HAProxy frontends created for deployments.

```sql
CREATE TABLE haproxy_frontends (
  id TEXT PRIMARY KEY,
  deploymentConfigId TEXT UNIQUE NOT NULL,
  frontendName TEXT UNIQUE NOT NULL,
  backendName TEXT NOT NULL,
  hostname TEXT NOT NULL,
  bindPort INTEGER DEFAULT 80,
  bindAddress TEXT DEFAULT '*',
  useSSL INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',    -- 'active', 'pending', 'failed', 'removed'
  errorMessage TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (deploymentConfigId) REFERENCES deployment_configurations(id)
);

CREATE INDEX idx_frontend_deploymentConfigId ON haproxy_frontends(deploymentConfigId);
CREATE INDEX idx_frontend_name ON haproxy_frontends(frontendName);
CREATE INDEX idx_frontend_hostname ON haproxy_frontends(hostname);
CREATE INDEX idx_frontend_status ON haproxy_frontends(status);
```

## Services

### CloudflareDNSService

Manages CloudFlare DNS zones and records.

**Location:** `server/src/services/cloudflare-dns.ts`

**Key Methods:**
- `listZones()` - List all DNS zones
- `findZoneForHostname(hostname)` - Find zone for a hostname
- `createDNSRecord(zoneId, record)` - Create A record
- `updateDNSRecord(zoneId, recordId, updates)` - Update record
- `deleteDNSRecord(zoneId, recordId)` - Delete record
- `getDNSRecord(zoneId, recordId)` - Get record details

### DeploymentDNSManager

Orchestrates DNS record lifecycle for deployments.

**Location:** `server/src/services/deployment-dns-manager.ts`

**Key Methods:**
- `createDNSRecordForDeployment(config)` - Create DNS for deployment
- `removeDNSRecordForDeployment(configId)` - Remove DNS record
- `updateDNSRecordIP(configId, newIP)` - Update IP address
- `getDNSRecordStatus(configId)` - Get DNS status

**Logic:**
- Checks environment network type
- Skips DNS for internet network type
- Creates CloudFlare A record for local network type
- Stores record info in database
- Handles errors gracefully

### HAProxyFrontendManager

Manages HAProxy frontend configurations.

**Location:** `server/src/services/haproxy/haproxy-frontend-manager.ts`

**Key Methods:**
- `createFrontendForDeployment(config, backendName, client)` - Create frontend
- `removeFrontendForDeployment(frontendName, client)` - Remove frontend
- `updateFrontendBackend(frontendName, backendName, client)` - Update routing
- `getFrontendStatus(frontendName, client)` - Check status

**Frontend Configuration:**
- Mode: `http`
- Bind: `*:80` (or configured port)
- ACL: `hdr(host) -i {hostname}`
- Rule: `use_backend {backendName} if {aclName}`

### NetworkUtils

Network utility functions.

**Location:** `server/src/services/network-utils.ts`

**Key Methods:**
- `getDockerHostPublicIP()` - Get public IP of Docker host
- `getDockerHostPrivateIP()` - Get private IP of Docker host
- `getAppropriateIPForEnvironment(envId)` - Get correct IP for environment

## API Endpoints

### DNS Management

```bash
# Get DNS records for deployment
GET /api/deployments/configs/:configId/dns

# Sync DNS record
POST /api/deployments/configs/:configId/dns/sync

# Delete DNS record
DELETE /api/deployments/configs/:configId/dns

# List all DNS records
GET /api/deployments/dns?status=active&hostname=api.example.com
```

### Frontend Management

```bash
# Get frontend for deployment
GET /api/deployments/configs/:configId/frontend

# Sync frontend
POST /api/deployments/configs/:configId/frontend/sync

# List all frontends
GET /api/haproxy/frontends?status=active

# Get frontend details
GET /api/haproxy/frontends/:frontendName
```

See [API Documentation](./projectmanagement/DNS-FRONTEND-API-DOCUMENTATION.md) for complete reference.

## Testing

### Integration Tests

Run integration tests (requires HAProxy container):

```bash
cd server
RUN_INTEGRATION_TESTS=true npm test -- deployment-dns-frontend.integration.test.ts
```

**Test Coverage:**
- Full deployment flow with DNS creation
- Removal flow with DNS cleanup
- Local vs internet network types
- Error scenarios and rollbacks
- Frontend creation and removal
- DNS record lifecycle

### End-to-End Testing

See [E2E Testing Guide](./projectmanagement/DNS-FRONTEND-E2E-TESTING.md) for manual testing scenarios.

**Key Scenarios:**
- Local network deployment with DNS
- Internet network deployment without DNS
- Blue-green deployment
- Deployment removal with cleanup
- Error handling (invalid hostname, zone not found, etc.)
- Manual sync operations

## Troubleshooting

Common issues and solutions:

### DNS Record Not Created

**Check:**
- Environment network type is `local`
- CloudFlare API credentials configured
- DNS zone exists in CloudFlare
- Deployment logs for errors

**Fix:**
- Manually sync DNS: `POST /api/deployments/configs/{id}/dns/sync`

### Frontend Not Created

**Check:**
- HAProxy container running
- Backend exists before frontend creation
- Deployment logs for errors

**Fix:**
- Manually sync frontend: `POST /api/deployments/configs/{id}/frontend/sync`

### Traffic Not Routing

**Check:**
- DNS resolves correctly: `nslookup hostname`
- HAProxy frontend exists
- Backend servers are healthy
- Application container running

**Fix:**
- Test with Host header: `curl -H "Host: hostname" http://haproxy-ip`
- Check HAProxy logs: `docker logs haproxy-container`

See [Troubleshooting Guide](./projectmanagement/DNS-FRONTEND-TROUBLESHOOTING.md) for complete reference.

## Monitoring

### Log Files

- **Deployment logs:** `server/logs/app-deployments.log`
  - DNS and frontend configuration steps
  - State machine transitions

- **Service logs:** `server/logs/app-services.log`
  - CloudFlare API calls
  - HAProxy DataPlane API calls

### Metrics

Track these metrics:
- DNS record creation time
- Frontend creation time
- Total deployment time impact
- DNS propagation time
- Error rates (DNS, frontend)

### UI Status Indicators

The deployment details page shows:
- **DNS Configuration** section
  - Hostname → IP mapping
  - Provider (CloudFlare)
  - Status badge (active/pending/failed)
  - Error messages
  - Sync button

- **HAProxy Frontend** section
  - Frontend name
  - Backend name
  - Hostname routing
  - Bind address and port
  - Status badge
  - Sync button

## Performance

### Timings

Typical timing for DNS and frontend configuration:
- **Frontend creation:** < 2 seconds
- **DNS record creation:** < 5 seconds
- **Total deployment impact:** < 10 seconds
- **DNS propagation:** 30 seconds to 5 minutes

### Optimization

- Frontend and DNS configured in parallel (where possible)
- Automatic retry with exponential backoff
- Circuit breaker for external API calls
- Cached zone lookups
- Transaction API for atomic HAProxy updates

## Security

### DNS Security

- CloudFlare API token stored encrypted
- Token scoped to specific zones
- Hostname validation prevents injection
- Zone ownership validated

### HAProxy Security

- DataPlane API authentication required
- Frontend names sanitized
- Backend names validated
- ACL names generated securely

### Network Security

- HAProxy ports exposed only as needed
- Firewall rules recommended
- SSL/TLS support (future enhancement)
- Rate limiting on API endpoints

## Limitations

### Current Limitations

1. **DNS Provider:** Only CloudFlare supported
   - Future: Route53, Google Cloud DNS

2. **SSL/TLS:** Not yet supported
   - Future: Automatic SSL certificate provisioning

3. **Port:** Only HTTP (port 80)
   - Future: HTTPS (port 443)

4. **Routing:** Hostname-based only
   - Future: Path-based, header-based routing

5. **Multi-Region:** Single Docker host only
   - Future: Multi-region DNS and load balancing

### Known Issues

- DNS propagation delay can cause brief unavailability
- HAProxy reload causes brief connection interruption
- Version conflicts in HAProxy require retry

## Future Enhancements

### Planned Features

1. **SSL/TLS Support**
   - Automatic certificate provisioning (Let's Encrypt)
   - SSL termination at HAProxy
   - HTTPS frontends

2. **Additional DNS Providers**
   - AWS Route53
   - Google Cloud DNS
   - Azure DNS

3. **Advanced Routing**
   - Path-based routing
   - Header-based routing
   - Weighted routing for A/B testing

4. **Multi-Region**
   - Geo-distributed DNS
   - Multi-region load balancing
   - Failover between regions

5. **Monitoring**
   - DNS health checks
   - HAProxy traffic metrics dashboard
   - Alerting on failures

6. **Automation**
   - Auto-update DNS on IP change
   - Scheduled DNS validation
   - Automatic SSL renewal

## References

- [HAProxy DataPlane API Documentation](https://www.haproxy.com/documentation/dataplaneapi/latest/)
- [CloudFlare API Documentation](https://developers.cloudflare.com/api/)
- [API Documentation](./projectmanagement/DNS-FRONTEND-API-DOCUMENTATION.md)
- [E2E Testing Guide](./projectmanagement/DNS-FRONTEND-E2E-TESTING.md)
- [Troubleshooting Guide](./projectmanagement/DNS-FRONTEND-TROUBLESHOOTING.md)

## Contributing

When working with DNS and frontend routing:

1. **Test thoroughly** - Use integration tests
2. **Handle errors gracefully** - DNS and network failures are common
3. **Log extensively** - DNS and HAProxy operations need good visibility
4. **Document changes** - Update this documentation
5. **Follow patterns** - Use existing service patterns

## Support

For issues or questions:

1. Check [Troubleshooting Guide](./projectmanagement/DNS-FRONTEND-TROUBLESHOOTING.md)
2. Review logs in `server/logs/`
3. Check CloudFlare and HAProxy directly
4. Create issue with details

---

**Version:** 1.0.0
**Last Updated:** 2025-01-15
