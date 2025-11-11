# DNS and Frontend Routing - End-to-End Testing Guide

## Overview

This document provides a comprehensive guide for end-to-end testing of the DNS and HAProxy Frontend routing feature. It covers manual testing procedures, automated test scenarios, and verification steps.

## Prerequisites

### Required Services

1. **HAProxy Container** - Running with DataPlane API enabled
   ```bash
   cd server/docker-compose
   docker compose -f docker-compose.haproxy.yml up -d
   ```

2. **CloudFlare Account** - With API credentials configured
   - API Token with DNS edit permissions
   - DNS Zone configured for your test domain
   - Credentials stored in system settings

3. **Docker Host** - Accessible and configured
   ```bash
   cd server && npm run show-dev-key
   ```

4. **Application Server** - Running in development mode
   ```bash
   npm run dev  # From project root
   ```

### Test Environment Setup

1. **Create Test Environment**
   - Name: `test-environment`
   - Network Type: `local`
   - Description: For DNS and frontend routing tests

2. **Configure System Settings**
   - Docker Host: Set to your Docker socket path
   - CloudFlare API Token: Set in system settings
   - Docker Host IP: Configure for DNS records

## Manual Test Scenarios

### Scenario 1: Full Deployment with DNS (Local Network)

**Objective:** Verify that a deployment in a local network creates both DNS records and HAProxy frontend.

**Steps:**

1. **Create Deployment Configuration**
   - Navigate to Deployments → Create New
   - Application Name: `test-app-local`
   - Hostname: `test-local.yourdomain.com`
   - Environment: Select `test-environment` (networkType: local)
   - Image: `nginx:latest`
   - Container Port: `80`
   - Replicas: `1`
   - Click "Create"

2. **Trigger Initial Deployment**
   - Click "Deploy" on the configuration
   - Monitor deployment progress in real-time

3. **Verify HAProxy Frontend Creation**
   - Check deployment details page for "HAProxy Frontend" section
   - Verify frontend name: `fe_test-app-local_<environment-id>`
   - Verify backend name: `be_test-app-local_<environment-id>`
   - Verify hostname routing: `test-local.yourdomain.com`
   - Verify bind address: `*:80`
   - Status should be: `active`

4. **Verify DNS Record Creation**
   - Check deployment details page for "DNS Configuration" section
   - Verify hostname: `test-local.yourdomain.com`
   - Verify provider: `cloudflare`
   - Verify IP address: Should match Docker host IP
   - Status should be: `active`

5. **Verify CloudFlare Dashboard**
   - Log into CloudFlare dashboard
   - Navigate to DNS settings for your zone
   - Verify A record exists: `test-local.yourdomain.com` → `<Docker Host IP>`
   - Verify TTL: `300` seconds
   - Verify Proxy status: `DNS only` (not proxied)

6. **Test Traffic Routing**
   - Update your local hosts file (or wait for DNS propagation):
     ```
     <Docker Host IP>  test-local.yourdomain.com
     ```
   - Open browser or use curl:
     ```bash
     curl -v http://test-local.yourdomain.com
     ```
   - Verify request reaches HAProxy
   - Verify HAProxy routes to correct backend
   - Verify response from application

7. **Verify HAProxy Configuration**
   - Access HAProxy stats page (if available)
   - Or query DataPlane API:
     ```bash
     curl -H "x-api-key: <api-key>" \
       http://localhost:5000/api/haproxy/frontends/fe_test-app-local_<env-id>
     ```
   - Verify ACL exists for hostname matching
   - Verify use_backend rule exists

**Expected Results:**

- ✅ Deployment completes successfully
- ✅ HAProxy frontend created with hostname routing
- ✅ DNS A record created in CloudFlare
- ✅ Traffic routes correctly through HAProxy
- ✅ Application responds to requests on hostname
- ✅ Frontend and DNS status shown in UI as "active"

---

### Scenario 2: Deployment without DNS (Internet Network)

**Objective:** Verify that a deployment in an internet network creates frontend but skips DNS.

**Steps:**

1. **Create Internet Environment**
   - Navigate to Environments → Create New
   - Name: `test-environment-internet`
   - Network Type: `internet`
   - Description: For internet-facing deployments

2. **Create Deployment Configuration**
   - Application Name: `test-app-internet`
   - Hostname: `test-internet.yourdomain.com`
   - Environment: Select `test-environment-internet` (networkType: internet)
   - Image: `nginx:latest`
   - Container Port: `80`
   - Click "Create"

3. **Trigger Deployment**
   - Click "Deploy"
   - Monitor deployment progress

4. **Verify HAProxy Frontend Creation**
   - Check deployment details for "HAProxy Frontend" section
   - Verify frontend was created
   - Status should be: `active`

5. **Verify DNS Record Skipped**
   - Check deployment details for "DNS Configuration" section
   - Should show "No DNS records configured" or empty
   - Verify no records in database:
     ```bash
     cd server
     echo "SELECT * FROM deployment_dns_records WHERE hostname = 'test-internet.yourdomain.com';" | sqlite3 prisma/dev.db
     ```

6. **Verify CloudFlare Dashboard**
   - Log into CloudFlare dashboard
   - Verify NO A record created for `test-internet.yourdomain.com`

7. **Check Application Logs**
   - Verify logs show message: "DNS configuration skipped for internet network type"

**Expected Results:**

- ✅ Deployment completes successfully
- ✅ HAProxy frontend created
- ✅ DNS record creation skipped
- ✅ No DNS records in CloudFlare
- ✅ Frontend status shown as "active"
- ✅ DNS section shows "No DNS records configured"

---

### Scenario 3: Deployment Removal with Cleanup

**Objective:** Verify that removing a deployment cleans up both frontend and DNS records.

**Steps:**

1. **Use Existing Deployment** from Scenario 1 (or create new one)
   - Ensure deployment has active frontend and DNS record

2. **Remove Deployment**
   - Navigate to deployment details page
   - Click "Remove Deployment"
   - Confirm removal
   - Monitor removal progress

3. **Verify Frontend Removal**
   - Check deployment details during removal
   - Frontend status should change to: `removing` → `removed`
   - Query HAProxy to verify frontend deleted:
     ```bash
     curl -H "x-api-key: <api-key>" \
       http://localhost:5000/api/haproxy/frontends/fe_test-app-local_<env-id>
     ```
   - Should return 404 or null

4. **Verify DNS Record Removal**
   - DNS status should change to: `removing` → `removed`
   - Check CloudFlare dashboard
   - Verify A record removed for hostname

5. **Verify Database Cleanup**
   - Check HAProxy frontend records:
     ```bash
     cd server
     echo "SELECT * FROM haproxy_frontends WHERE deploymentConfigId = '<config-id>';" | sqlite3 prisma/dev.db
     ```
   - Status should be `removed`

   - Check DNS records:
     ```bash
     echo "SELECT * FROM deployment_dns_records WHERE deploymentConfigId = '<config-id>';" | sqlite3 prisma/dev.db
     ```
   - Status should be `removed`

6. **Verify Traffic No Longer Routes**
   - Try to access hostname:
     ```bash
     curl -v http://test-local.yourdomain.com
     ```
   - Should fail or return HAProxy error (no backend)

**Expected Results:**

- ✅ Deployment removal completes successfully
- ✅ HAProxy frontend removed
- ✅ DNS A record removed from CloudFlare
- ✅ Database records marked as `removed`
- ✅ Traffic no longer routes to application
- ✅ No orphaned resources

---

### Scenario 4: Blue-Green Deployment with DNS/Frontend

**Objective:** Verify that blue-green deployments update frontend but maintain DNS records.

**Steps:**

1. **Create Initial Deployment** (Blue)
   - Application Name: `test-app-bluegreen`
   - Hostname: `test-bluegreen.yourdomain.com`
   - Image: `nginx:1.20`
   - Environment: local network type

2. **Verify Initial Setup**
   - Frontend created for blue deployment
   - DNS record created
   - Traffic routes to blue

3. **Trigger Blue-Green Deployment** (Green)
   - Update deployment configuration
   - Change image to: `nginx:1.21`
   - Deployment strategy should be: `bluegreen`
   - Click "Deploy"

4. **Monitor Deployment Progress**
   - Green container starts
   - Green backend created
   - Green health checks pass
   - Frontend configured for green
   - Traffic opens to green
   - Blue backend drains
   - Blue container stops

5. **Verify Frontend Update**
   - Frontend should now route to green backend
   - Check frontend configuration:
     ```bash
     curl -H "x-api-key: <api-key>" \
       http://localhost:5000/api/deployments/configs/<config-id>/frontend
     ```
   - Backend name should reference green backend

6. **Verify DNS Remains Stable**
   - DNS record should remain unchanged
   - Same hostname → same IP
   - No DNS record recreation
   - Check DNS record timestamps - should not change

7. **Test Traffic**
   - Make request to hostname
   - Should receive response from green deployment (nginx 1.21)

**Expected Results:**

- ✅ Blue-green deployment completes successfully
- ✅ Frontend updated to route to green backend
- ✅ DNS record remains stable (not recreated)
- ✅ Traffic smoothly transitions from blue to green
- ✅ Zero downtime experienced
- ✅ Blue resources cleaned up after green is active

---

### Scenario 5: Error Handling - Invalid Hostname

**Objective:** Verify graceful handling of invalid hostname configurations.

**Steps:**

1. **Create Deployment with Invalid Hostname**
   - Try to create config with invalid hostname: `invalid..hostname`
   - Or missing TLD: `testapp`
   - Or invalid characters: `test@app.com`

2. **Expected Behavior**
   - Validation error shown at config creation
   - OR deployment fails with clear error message
   - Error message indicates hostname issue

3. **Verify No Resources Created**
   - No frontend created
   - No DNS record created
   - No orphaned resources

**Expected Results:**

- ✅ Validation prevents invalid hostname
- ✅ Clear error message shown to user
- ✅ No partial resources created
- ✅ System remains in clean state

---

### Scenario 6: Error Handling - CloudFlare Zone Not Found

**Objective:** Verify handling when DNS zone doesn't exist in CloudFlare.

**Steps:**

1. **Create Deployment with Unknown Zone**
   - Hostname: `test.nonexistentzone.com`
   - Zone `nonexistentzone.com` doesn't exist in CloudFlare

2. **Trigger Deployment**
   - Deployment starts
   - Frontend creation succeeds
   - DNS creation fails with zone error

3. **Verify Error Handling**
   - Deployment status: may show as "partially successful" or "failed"
   - DNS record status: `failed`
   - Error message: "Zone not found for hostname"
   - Frontend status: should still be `active` (independent of DNS)

4. **Verify UI Shows Error**
   - Deployment details page shows DNS error
   - Error message clearly indicates zone issue
   - User can see that frontend is working but DNS failed

5. **Manual Sync Option**
   - After fixing zone issue (adding to CloudFlare)
   - Click "Sync DNS" button
   - DNS record should be created successfully
   - Status changes to `active`

**Expected Results:**

- ✅ Deployment continues despite DNS error
- ✅ Frontend created and functional
- ✅ DNS error recorded with clear message
- ✅ User can manually retry DNS creation
- ✅ System doesn't block deployment on DNS issues

---

### Scenario 7: Manual DNS Sync

**Objective:** Verify manual DNS synchronization functionality.

**Steps:**

1. **Create Deployment** with DNS record

2. **Manually Delete DNS Record** from CloudFlare dashboard

3. **Verify Mismatch**
   - Database shows DNS record as `active`
   - CloudFlare shows no record

4. **Trigger Manual Sync**
   - Navigate to deployment details
   - Click "Sync DNS" button
   - Monitor sync progress

5. **Verify DNS Recreated**
   - DNS record recreated in CloudFlare
   - Status remains `active`
   - IP address correct

**Expected Results:**

- ✅ Manual sync recreates DNS record
- ✅ Sync completes without errors
- ✅ Database and CloudFlare are in sync
- ✅ User receives success notification

---

## Automated Test Execution

### Integration Tests

Run the full integration test suite:

```bash
cd server
RUN_INTEGRATION_TESTS=true npm test -- deployment-dns-frontend.integration.test.ts
```

**Test Coverage:**

- ✅ Frontend creation with hostname routing
- ✅ DNS record creation for local networks
- ✅ DNS skipping for internet networks
- ✅ Frontend and DNS removal on deployment deletion
- ✅ Error handling for missing backends
- ✅ Duplicate frontend handling
- ✅ State machine integration

### Unit Tests

Run specific service unit tests:

```bash
cd server
npm test -- cloudflare-dns.test.ts
npm test -- haproxy-frontend-manager.test.ts
npm test -- deployment-dns-manager.test.ts
```

## Verification Checklist

### Deployment Creation

- [ ] HAProxy frontend created in DataPlane API
- [ ] Frontend configuration includes hostname ACL
- [ ] Frontend configuration includes use_backend rule
- [ ] Frontend bind created on port 80
- [ ] Frontend record created in database with status `active`
- [ ] DNS A record created in CloudFlare (local network only)
- [ ] DNS record points to correct Docker host IP
- [ ] DNS record TTL set to 300 seconds
- [ ] DNS record created in database with status `active`
- [ ] Deployment details page shows frontend info
- [ ] Deployment details page shows DNS info (if applicable)
- [ ] Application accessible via hostname

### Deployment Removal

- [ ] Frontend removed from HAProxy DataPlane API
- [ ] Frontend record status changed to `removed` in database
- [ ] DNS A record removed from CloudFlare
- [ ] DNS record status changed to `removed` in database
- [ ] Application no longer accessible via hostname
- [ ] No orphaned HAProxy configuration
- [ ] No orphaned DNS records

### Error Scenarios

- [ ] Invalid hostname rejected at creation
- [ ] Missing CloudFlare zone handled gracefully
- [ ] Network errors retried with exponential backoff
- [ ] Version conflicts in HAProxy handled automatically
- [ ] Partial failures don't block deployment
- [ ] Clear error messages shown to user
- [ ] Manual recovery options available

### UI/UX

- [ ] Frontend status badge shows correct state
- [ ] DNS status badge shows correct state
- [ ] Sync buttons work correctly
- [ ] Error messages are clear and actionable
- [ ] Real-time status updates during deployment
- [ ] Logs show detailed progress information

## Troubleshooting

### Frontend Not Created

**Symptoms:** Deployment completes but no frontend in HAProxy

**Checks:**
1. Check deployment logs: `server/logs/app-deployments.log`
2. Check HAProxy DataPlane API accessibility
3. Verify backend exists before frontend creation
4. Check HAProxy version compatibility

**Resolution:**
- Manually trigger frontend sync
- Check HAProxy container logs
- Verify DataPlane API credentials

### DNS Record Not Created

**Symptoms:** Frontend works but no DNS record in CloudFlare

**Checks:**
1. Verify environment network type is `local`
2. Check CloudFlare API credentials in system settings
3. Verify DNS zone exists in CloudFlare
4. Check application logs: `server/logs/app-deployments.log`
5. Check DNS record in database for error message

**Resolution:**
- Verify CloudFlare API token permissions
- Manually trigger DNS sync
- Check zone ownership in CloudFlare

### Traffic Not Routing

**Symptoms:** DNS resolves but requests don't reach application

**Checks:**
1. Verify HAProxy frontend exists and is active
2. Check backend exists and has active servers
3. Verify hostname ACL configured correctly
4. Check HAProxy logs for routing errors
5. Verify application container is running and healthy

**Resolution:**
- Check HAProxy configuration with DataPlane API
- Verify backend health status
- Check container logs for application errors

### DNS Not Propagating

**Symptoms:** DNS record created but hostname doesn't resolve

**Checks:**
1. Check DNS TTL (should be 300 seconds)
2. Verify IP address is correct in CloudFlare
3. Check if DNS is proxied (should be DNS only)
4. Use DNS lookup tools: `nslookup test.domain.com 8.8.8.8`
5. Clear local DNS cache

**Resolution:**
- Wait for DNS propagation (up to 5 minutes)
- Verify CloudFlare nameservers are authoritative
- Use CloudFlare's DNS checker tool

## Performance Metrics

Track these metrics during E2E testing:

1. **Frontend Creation Time**
   - Target: < 2 seconds
   - Measure: Time from frontend creation start to active status

2. **DNS Record Creation Time**
   - Target: < 5 seconds
   - Measure: Time from DNS API call to record active in CloudFlare

3. **Total Deployment Time Impact**
   - Baseline: Deployment without DNS/frontend
   - With DNS/frontend: Should add < 10 seconds
   - Measure: State machine total execution time

4. **Removal Time**
   - Target: < 5 seconds for frontend + DNS removal
   - Measure: Time from removal trigger to resources deleted

5. **DNS Propagation Time**
   - Expected: 30 seconds to 5 minutes
   - Measure: Time until DNS resolves globally

## Test Data Cleanup

After completing E2E tests, clean up test data:

```bash
# Remove test deployments from database
cd server
echo "DELETE FROM deployment_dns_records WHERE hostname LIKE 'test-%';" | sqlite3 prisma/dev.db
echo "DELETE FROM haproxy_frontends WHERE frontendName LIKE 'fe_test-%';" | sqlite3 prisma/dev.db

# Remove test environments
echo "DELETE FROM environments WHERE name LIKE 'test-%';" | sqlite3 prisma/dev.db

# Clean up CloudFlare DNS records
# (Do this manually in CloudFlare dashboard or via API script)
```

## Conclusion

This E2E testing guide provides comprehensive coverage of the DNS and HAProxy frontend routing feature. Follow these scenarios to ensure the feature works correctly in all conditions and handles errors gracefully.

For issues or questions, refer to the troubleshooting guide or check application logs in `server/logs/`.
