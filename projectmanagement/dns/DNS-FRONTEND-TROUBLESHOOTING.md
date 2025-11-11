# DNS and HAProxy Frontend Routing - Troubleshooting Guide

## Overview

This guide helps diagnose and resolve common issues with DNS record management and HAProxy frontend routing for deployments.

## Table of Contents

1. [DNS Issues](#dns-issues)
2. [HAProxy Frontend Issues](#haproxy-frontend-issues)
3. [Network Connectivity Issues](#network-connectivity-issues)
4. [Deployment State Machine Issues](#deployment-state-machine-issues)
5. [Database Issues](#database-issues)
6. [Logging and Debugging](#logging-and-debugging)
7. [Common Error Messages](#common-error-messages)

---

## DNS Issues

### DNS Record Not Created

**Symptoms:**
- Deployment completes successfully
- HAProxy frontend exists
- No DNS record in CloudFlare
- DNS record status shows "failed" or doesn't exist

**Possible Causes:**

1. **Environment network type is not "local"**
   - DNS records are only created for environments with networkType: "local"
   - Internet-facing environments skip DNS creation

2. **CloudFlare API credentials not configured**
   - API token not set in system settings
   - API token expired or revoked

3. **CloudFlare zone not found**
   - Hostname's zone doesn't exist in CloudFlare account
   - Zone name mismatch (e.g., `example.com` vs `www.example.com`)

4. **CloudFlare API permissions insufficient**
   - API token doesn't have DNS edit permissions
   - API token scoped to wrong zone

5. **Docker host IP not configured**
   - System setting for Docker host IP is missing
   - IP address detection failed

**Diagnosis:**

```bash
# Check environment network type
cd server
echo "SELECT id, name, networkType FROM environments WHERE id = 'your-env-id';" | sqlite3 prisma/dev.db

# Check DNS record status
echo "SELECT * FROM deployment_dns_records WHERE deploymentConfigId = 'your-config-id';" | sqlite3 prisma/dev.db

# Check CloudFlare API settings
echo "SELECT * FROM system_settings WHERE category = 'cloudflare';" | sqlite3 prisma/dev.db

# Check deployment logs
tail -f logs/app-deployments.log | grep -i dns

# Check service logs
tail -f logs/app-services.log | grep -i cloudflare
```

**Resolution:**

1. **Verify environment network type:**
   ```bash
   # Update environment if needed
   echo "UPDATE environments SET networkType = 'local' WHERE id = 'your-env-id';" | sqlite3 prisma/dev.db
   ```

2. **Configure CloudFlare API credentials:**
   - Navigate to Settings → System → CloudFlare
   - Add API token with DNS edit permissions
   - Verify token by clicking "Test Connection"

3. **Verify CloudFlare zone exists:**
   - Log into CloudFlare dashboard
   - Check that the zone for your hostname exists
   - Example: For `api.example.com`, zone `example.com` must exist

4. **Check API token permissions:**
   - Go to CloudFlare dashboard → API Tokens
   - Verify token has "Zone.DNS" edit permission
   - Verify token is scoped to correct zone (or all zones)

5. **Configure Docker host IP:**
   - Navigate to Settings → System → Docker
   - Set "Docker Host IP" setting
   - Or let system auto-detect IP

6. **Manually trigger DNS sync:**
   ```bash
   # Via API
   curl -X POST -H "x-api-key: your-key" \
     http://localhost:5000/api/deployments/configs/your-config-id/dns/sync
   ```

   - Or use UI: Navigate to deployment details → Click "Sync DNS"

---

### DNS Record Points to Wrong IP

**Symptoms:**
- DNS record created successfully
- IP address in CloudFlare is incorrect
- Traffic doesn't reach application

**Possible Causes:**

1. **Docker host IP changed**
   - Host IP changed after DNS record creation
   - Dynamic IP assignment

2. **Incorrect IP configured in settings**
   - Manual IP override is incorrect
   - Private IP used instead of public IP (or vice versa)

3. **Multiple network interfaces**
   - System detected wrong network interface
   - VPN or virtual adapter interference

**Diagnosis:**

```bash
# Check current DNS record
cd server
echo "SELECT hostname, ipAddress FROM deployment_dns_records WHERE deploymentConfigId = 'your-config-id';" | sqlite3 prisma/dev.db

# Check CloudFlare record
curl -H "x-api-key: your-api-key" \
  http://localhost:5000/api/deployments/configs/your-config-id/dns

# Check Docker host IP setting
echo "SELECT value FROM system_settings WHERE category = 'docker' AND key = 'hostIp';" | sqlite3 prisma/dev.db

# Get actual host IP
curl ifconfig.me
```

**Resolution:**

1. **Update Docker host IP setting:**
   - Navigate to Settings → System → Docker
   - Update "Docker Host IP" to correct IP
   - Save changes

2. **Manually sync DNS record:**
   - Navigate to deployment details
   - Click "Sync DNS" button
   - Verify IP updated in CloudFlare

3. **Or use API to sync:**
   ```bash
   curl -X POST -H "x-api-key: your-key" \
     http://localhost:5000/api/deployments/configs/your-config-id/dns/sync
   ```

---

### DNS Not Propagating

**Symptoms:**
- DNS record exists in CloudFlare
- `nslookup` or `dig` doesn't resolve hostname
- Hostname doesn't work in browser

**Possible Causes:**

1. **DNS propagation delay**
   - DNS changes take time to propagate (5 seconds to 5 minutes)
   - Local DNS cache not updated

2. **DNS record proxied through CloudFlare**
   - CloudFlare proxy enabled (orange cloud)
   - Should be DNS only (gray cloud) for direct routing

3. **CloudFlare nameservers not authoritative**
   - Domain not using CloudFlare nameservers
   - DNS zone not fully activated

4. **Incorrect TTL**
   - TTL set too high
   - Old record cached

**Diagnosis:**

```bash
# Check DNS resolution
nslookup your-hostname.example.com

# Check using CloudFlare DNS
nslookup your-hostname.example.com 1.1.1.1

# Check using Google DNS
nslookup your-hostname.example.com 8.8.8.8

# Check DNS record details
dig your-hostname.example.com +short

# Check authoritative nameservers
dig NS example.com +short

# Check CloudFlare record proxy status
# (via CloudFlare dashboard or API)
```

**Resolution:**

1. **Wait for propagation:**
   - Wait 5-10 minutes
   - Flush local DNS cache:
     ```bash
     # Windows
     ipconfig /flushdns

     # macOS
     sudo dscacheutil -flushcache

     # Linux
     sudo systemd-resolve --flush-caches
     ```

2. **Disable CloudFlare proxy:**
   - Log into CloudFlare dashboard
   - Navigate to DNS settings
   - Click on the DNS record
   - Disable proxy (change orange cloud to gray cloud)
   - Or set `proxied: false` in system settings

3. **Verify nameservers:**
   - Check domain registrar settings
   - Ensure domain uses CloudFlare nameservers
   - Example CloudFlare nameservers:
     - `ns1.cloudflare.com`
     - `ns2.cloudflare.com`

4. **Lower TTL:**
   - CloudFlare TTL should be 300 seconds (automatic)
   - Wait for old TTL to expire before changes take effect

---

## HAProxy Frontend Issues

### Frontend Not Created

**Symptoms:**
- Deployment completes
- No frontend in HAProxy
- Frontend status shows "failed" or doesn't exist
- Traffic doesn't route to application

**Possible Causes:**

1. **HAProxy DataPlane API not accessible**
   - HAProxy container not running
   - DataPlane API not enabled
   - Network connectivity issues

2. **Backend doesn't exist**
   - Backend creation failed before frontend creation
   - Backend name mismatch

3. **HAProxy version conflict**
   - Concurrent modifications to HAProxy configuration
   - Version number out of sync

4. **Port already in use**
   - Port 80 (or target port) already bound
   - Conflicting frontend exists

**Diagnosis:**

```bash
# Check HAProxy container status
docker ps | grep haproxy

# Check frontend in database
cd server
echo "SELECT * FROM haproxy_frontends WHERE deploymentConfigId = 'your-config-id';" | sqlite3 prisma/dev.db

# Check HAProxy DataPlane API accessibility
curl http://haproxy-container-ip:5555/v3/services/haproxy/configuration/frontends

# Check deployment logs
tail -f logs/app-deployments.log | grep -i frontend

# Check for error messages
echo "SELECT errorMessage FROM haproxy_frontends WHERE deploymentConfigId = 'your-config-id';" | sqlite3 prisma/dev.db
```

**Resolution:**

1. **Verify HAProxy container running:**
   ```bash
   docker ps --filter "name=haproxy"
   ```
   - If not running, start it:
     ```bash
     cd server/docker-compose
     docker compose -f docker-compose.haproxy.yml up -d
     ```

2. **Verify backend exists:**
   ```bash
   # Via API
   curl -H "x-api-key: your-key" \
     http://localhost:5000/api/haproxy/backends

   # Or via DataPlane API directly
   curl http://haproxy-ip:5555/v3/services/haproxy/configuration/backends
   ```

3. **Manually sync frontend:**
   ```bash
   curl -X POST -H "x-api-key: your-key" \
     http://localhost:5000/api/deployments/configs/your-config-id/frontend/sync
   ```

4. **Check for port conflicts:**
   ```bash
   # Check what's listening on port 80
   netstat -tulpn | grep :80

   # Or on Windows
   netstat -ano | findstr :80
   ```

5. **Restart HAProxy if needed:**
   ```bash
   docker restart haproxy-container-name
   ```

---

### Frontend Configuration Incorrect

**Symptoms:**
- Frontend exists in HAProxy
- Traffic doesn't route to correct backend
- Wrong hostname matching
- 404 or 503 errors

**Possible Causes:**

1. **ACL not configured correctly**
   - Hostname ACL missing or incorrect
   - Case sensitivity issues

2. **Backend rule not configured**
   - use_backend rule missing
   - Wrong backend name in rule

3. **Default backend mismatch**
   - Frontend default_backend points to wrong backend
   - Backend name typo

4. **Bind configuration issues**
   - Bind address incorrect
   - Port mismatch

**Diagnosis:**

```bash
# Check frontend details
curl -H "x-api-key: your-key" \
  http://localhost:5000/api/haproxy/frontends/fe_your_app

# Check HAProxy configuration directly
docker exec haproxy-container cat /etc/haproxy/haproxy.cfg | grep -A 20 "frontend fe_your_app"

# Check ACLs
curl http://haproxy-ip:5555/v3/services/haproxy/configuration/acls?parent_type=frontend&parent_name=fe_your_app

# Check backend rules
curl http://haproxy-ip:5555/v3/services/haproxy/configuration/backend_switching_rules?frontend=fe_your_app

# Test routing
curl -H "Host: your-hostname.com" http://haproxy-ip
```

**Resolution:**

1. **Verify ACL configuration:**
   - ACL should match hostname exactly
   - Check case sensitivity
   - Expected ACL: `hdr(host) -i your-hostname.com`

2. **Verify backend switching rule:**
   - Rule should use correct ACL name
   - Backend name should match exactly
   - Expected rule: `use_backend be_app_env if acl_name`

3. **Manually reconfigure frontend:**
   ```bash
   # Delete and recreate frontend
   curl -X DELETE -H "x-api-key: your-key" \
     http://localhost:5000/api/haproxy/frontends/fe_your_app

   curl -X POST -H "x-api-key: your-key" \
     http://localhost:5000/api/deployments/configs/your-config-id/frontend/sync
   ```

4. **Check HAProxy logs:**
   ```bash
   docker logs haproxy-container | tail -100
   ```

---

### Frontend Deleted But Still Exists

**Symptoms:**
- Frontend marked as "removed" in database
- Frontend still exists in HAProxy configuration
- Old frontend continues routing traffic

**Possible Causes:**

1. **HAProxy configuration not reloaded**
   - Delete operation completed but reload failed
   - DataPlane API transaction not committed

2. **HAProxy runtime vs configuration mismatch**
   - Configuration file updated
   - Runtime not reloaded

**Diagnosis:**

```bash
# Check frontend in database
cd server
echo "SELECT status FROM haproxy_frontends WHERE frontendName = 'fe_your_app';" | sqlite3 prisma/dev.db

# Check frontend in HAProxy
curl http://haproxy-ip:5555/v3/services/haproxy/configuration/frontends/fe_your_app

# Check HAProxy runtime
curl http://haproxy-ip:5555/v3/services/haproxy/runtime/frontends
```

**Resolution:**

1. **Force reload HAProxy:**
   ```bash
   docker exec haproxy-container kill -HUP 1
   ```

2. **Manually delete frontend via DataPlane API:**
   ```bash
   curl -X DELETE \
     "http://haproxy-ip:5555/v3/services/haproxy/configuration/frontends/fe_your_app?version=X"
   ```

3. **Restart HAProxy container:**
   ```bash
   docker restart haproxy-container
   ```

---

## Network Connectivity Issues

### Cannot Reach Application via Hostname

**Symptoms:**
- DNS resolves correctly
- Frontend and backend exist in HAProxy
- Requests to hostname fail or timeout

**Possible Causes:**

1. **HAProxy not accessible**
   - Firewall blocking port 80/443
   - HAProxy not listening on correct interface

2. **Backend servers down**
   - Application containers not running
   - Health checks failing

3. **Network routing issues**
   - HAProxy can't reach backend containers
   - Docker network misconfiguration

4. **HAProxy configuration errors**
   - Syntax errors in configuration
   - HAProxy not running

**Diagnosis:**

```bash
# Test DNS resolution
nslookup your-hostname.com

# Test connectivity to HAProxy
curl -v http://haproxy-ip

# Test with Host header
curl -v -H "Host: your-hostname.com" http://haproxy-ip

# Check HAProxy is listening
netstat -tulpn | grep :80

# Check HAProxy status
docker ps | grep haproxy

# Check backend servers
curl -H "x-api-key: your-key" \
  http://localhost:5000/api/haproxy/backends/be_your_app/servers

# Check backend health
curl http://haproxy-ip:5555/v3/services/haproxy/stats/native?type=backend

# Check application container
docker ps | grep your-app-container
```

**Resolution:**

1. **Verify HAProxy is accessible:**
   ```bash
   # Test HAProxy directly
   curl -v http://haproxy-ip
   ```
   - If not accessible, check firewall rules
   - Verify HAProxy container has correct port mapping

2. **Check backend server health:**
   ```bash
   # Get server stats
   curl http://haproxy-ip:5555/v3/services/haproxy/stats/native?type=server&backend=be_your_app
   ```
   - If server status is DOWN, check application health
   - Verify health check endpoint works

3. **Verify network connectivity:**
   ```bash
   # From HAProxy container to application
   docker exec haproxy-container curl http://app-container-ip:port/health
   ```
   - If fails, check Docker network configuration
   - Ensure containers on same network or can route to each other

4. **Check HAProxy logs:**
   ```bash
   docker logs haproxy-container | grep -i error
   ```

5. **Restart application container:**
   ```bash
   docker restart app-container-name
   ```

---

## Deployment State Machine Issues

### Deployment Stuck in "Configuring Frontend" State

**Symptoms:**
- Deployment progress stops at frontend configuration
- State machine doesn't transition
- Deployment never completes

**Possible Causes:**

1. **State machine action threw error**
   - Frontend creation failed
   - Action didn't send event

2. **State machine event not processed**
   - Event queue blocked
   - State machine instance frozen

3. **Database transaction deadlock**
   - Multiple deployments conflicting
   - Lock timeout

**Diagnosis:**

```bash
# Check deployment status
cd server
echo "SELECT id, status, currentState FROM deployment_operations WHERE id = 'your-op-id';" | sqlite3 prisma/dev.db

# Check deployment logs
tail -f logs/app-deployments.log | grep "your-operation-id"

# Check for errors
grep -i "error" logs/app-deployments.log | tail -50

# Check state machine context
echo "SELECT context FROM deployment_operations WHERE id = 'your-op-id';" | sqlite3 prisma/dev.db
```

**Resolution:**

1. **Check logs for specific error:**
   ```bash
   grep "your-operation-id" logs/app-deployments.log | grep -i error
   ```

2. **Manually fix frontend if needed:**
   ```bash
   curl -X POST -H "x-api-key: your-key" \
     http://localhost:5000/api/deployments/configs/your-config-id/frontend/sync
   ```

3. **Cancel and retry deployment:**
   - Stop stuck deployment
   - Trigger new deployment

4. **Check for database locks:**
   ```bash
   # SQLite doesn't have great lock visibility
   # But you can try to access the database
   sqlite3 prisma/dev.db "SELECT 1;"
   ```

---

### Deployment Stuck in "Configuring DNS" State

**Symptoms:**
- Deployment stops at DNS configuration
- State never transitions
- DNS record not created

**Diagnosis:**

```bash
# Check deployment operation state
cd server
echo "SELECT currentState, context FROM deployment_operations WHERE id = 'your-op-id';" | sqlite3 prisma/dev.db

# Check DNS logs
grep "DNS" logs/app-deployments.log | tail -50

# Check CloudFlare service logs
grep "cloudflare" logs/app-services.log | tail -50
```

**Resolution:**

1. **Check CloudFlare API connectivity:**
   ```bash
   # Test CloudFlare API
   curl -X GET "https://api.cloudflare.com/client/v4/zones" \
     -H "Authorization: Bearer your-cloudflare-token"
   ```

2. **Manually create DNS record:**
   ```bash
   curl -X POST -H "x-api-key: your-key" \
     http://localhost:5000/api/deployments/configs/your-config-id/dns/sync
   ```

3. **Skip DNS and continue deployment:**
   - If DNS not critical, can continue deployment
   - DNS can be created manually later

---

## Database Issues

### Frontend Record Missing from Database

**Symptoms:**
- Frontend exists in HAProxy
- No record in haproxy_frontends table
- UI doesn't show frontend information

**Diagnosis:**

```bash
cd server
echo "SELECT * FROM haproxy_frontends WHERE frontendName = 'fe_your_app';" | sqlite3 prisma/dev.db

# Check if deployment config exists
echo "SELECT id FROM deployment_configurations WHERE id = 'your-config-id';" | sqlite3 prisma/dev.db
```

**Resolution:**

1. **Manually create database record:**
   ```sql
   INSERT INTO haproxy_frontends (
     id, deploymentConfigId, frontendName, backendName,
     hostname, bindPort, bindAddress, useSSL, status
   ) VALUES (
     'new_id', 'your-config-id', 'fe_your_app', 'be_your_app',
     'your-hostname.com', 80, '*', 0, 'active'
   );
   ```

2. **Or sync from HAProxy:**
   ```bash
   curl -X POST -H "x-api-key: your-key" \
     http://localhost:5000/api/deployments/configs/your-config-id/frontend/sync
   ```

---

### DNS Record Status Incorrect

**Symptoms:**
- DNS record shows "active" but doesn't exist in CloudFlare
- DNS record shows "failed" but exists in CloudFlare
- Status out of sync

**Resolution:**

1. **Manually sync DNS:**
   ```bash
   curl -X POST -H "x-api-key: your-key" \
     http://localhost:5000/api/deployments/configs/your-config-id/dns/sync
   ```

2. **Manually update status:**
   ```bash
   cd server
   echo "UPDATE deployment_dns_records SET status = 'active' WHERE id = 'your-record-id';" | sqlite3 prisma/dev.db
   ```

---

## Logging and Debugging

### Enable Debug Logging

To enable detailed debug logging for DNS and frontend operations:

1. **Update logging configuration:**
   ```bash
   cd server/config
   # Edit logging.json
   ```

   Add or update:
   ```json
   {
     "level": "debug",
     "domains": {
       "deployments": "debug",
       "services": "debug"
     }
   }
   ```

2. **Restart server:**
   ```bash
   npm run dev
   ```

### Key Log Files

- **Deployment logs:** `server/logs/app-deployments.log`
  - State machine transitions
  - Frontend configuration steps
  - DNS configuration steps

- **Service logs:** `server/logs/app-services.log`
  - CloudFlare API calls
  - HAProxy DataPlane API calls
  - Network utility operations

- **HTTP logs:** `server/logs/app-http.log`
  - API requests and responses
  - Authentication events

- **All logs:** `server/logs/app-all.log`
  - Combined logs from all sources

### Search Logs

```bash
cd server/logs

# Search for specific deployment operation
grep "operation-id" app-deployments.log

# Search for DNS-related logs
grep -i "dns" app-deployments.log

# Search for frontend-related logs
grep -i "frontend" app-deployments.log

# Search for errors
grep -i "error" app-all.log | tail -50

# Search for CloudFlare API issues
grep "cloudflare" app-services.log | grep -i "error"

# Search for HAProxy issues
grep "haproxy" app-services.log | grep -i "error"

# Real-time monitoring
tail -f app-deployments.log
```

---

## Common Error Messages

### "Zone not found for hostname"

**Meaning:** CloudFlare zone doesn't exist for the hostname's domain.

**Resolution:**
- Verify zone exists in CloudFlare dashboard
- For `api.example.com`, zone `example.com` must exist
- Add zone to CloudFlare if missing

---

### "CloudFlare API authentication failed"

**Meaning:** CloudFlare API token is invalid or expired.

**Resolution:**
- Verify API token in system settings
- Generate new API token in CloudFlare dashboard
- Ensure token has DNS edit permissions

---

### "Backend not found for frontend creation"

**Meaning:** HAProxy backend doesn't exist yet.

**Resolution:**
- Verify backend was created successfully
- Check deployment logs for backend creation errors
- May need to retry deployment from beginning

---

### "Version conflict in HAProxy configuration"

**Meaning:** HAProxy configuration version changed during operation.

**Resolution:**
- System should automatically retry
- If persists, may indicate concurrent modifications
- Wait a few seconds and try again

---

### "Failed to detect Docker host IP"

**Meaning:** System couldn't determine Docker host IP address.

**Resolution:**
- Manually configure Docker host IP in system settings
- Settings → System → Docker → "Docker Host IP"
- Use external IP if accessible from internet

---

### "DNS record already exists"

**Meaning:** DNS record already exists in CloudFlare.

**Resolution:**
- System should update existing record
- If error persists, manually check CloudFlare dashboard
- May be duplicate records

---

## Getting Help

If issues persist after following this guide:

1. **Check Logs:**
   - Review all relevant log files
   - Look for error stack traces
   - Note any error codes

2. **Gather Information:**
   - Deployment configuration ID
   - Environment ID
   - Error messages
   - Timestamps
   - Steps to reproduce

3. **Test Components Individually:**
   - Test CloudFlare API separately
   - Test HAProxy DataPlane API separately
   - Test Docker connectivity
   - Verify each component works in isolation

4. **Document Issue:**
   - Create detailed issue report
   - Include logs, configuration, and error messages
   - Include steps to reproduce

5. **Contact Support:**
   - Submit issue with full details
   - Provide log excerpts
   - Be specific about what's not working

---

## Quick Reference Commands

```bash
# View logs
tail -f server/logs/app-deployments.log

# Check DNS record
echo "SELECT * FROM deployment_dns_records;" | sqlite3 server/prisma/dev.db

# Check frontend
echo "SELECT * FROM haproxy_frontends;" | sqlite3 server/prisma/dev.db

# Sync DNS
curl -X POST -H "x-api-key: KEY" http://localhost:5000/api/deployments/configs/ID/dns/sync

# Sync frontend
curl -X POST -H "x-api-key: KEY" http://localhost:5000/api/deployments/configs/ID/frontend/sync

# Check HAProxy
docker ps | grep haproxy
docker logs haproxy-container

# Test DNS
nslookup your-hostname.com

# Test HAProxy routing
curl -H "Host: your-hostname.com" http://haproxy-ip
```
