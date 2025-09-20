#!/usr/bin/env tsx

/**
 * HAProxy DataPlane Client Demo
 *
 * This script demonstrates how to use the HAProxy DataPlane client
 * to manage backends, servers, and perform deployments.
 *
 * Prerequisites:
 * - HAProxy container running with DataPlane API enabled
 * - Container should be labeled with mini-infra.service=haproxy
 *
 * Usage: tsx src/examples/haproxy-dataplane-demo.ts
 */

import { HAProxyDataPlaneClient } from '../services/haproxy/haproxy-dataplane-client';
import DockerService from '../services/docker';

async function demonstrateHAProxyClient() {
  console.log('🚀 HAProxy DataPlane Client Demo');
  console.log('=====================================\n');

  try {
    // Initialize Docker service to find HAProxy container
    console.log('1. Initializing Docker service...');
    const dockerService = DockerService.getInstance();
    await dockerService.initialize();

    // Find HAProxy container
    console.log('2. Finding HAProxy container...');
    const containers = await dockerService.listContainers();

    const haproxyContainer = containers.find((container: any) => {
      const labels = container.labels || {};
      return (
        labels['mini-infra.service'] === 'haproxy' &&
        container.status === 'running'
      );
    });

    if (!haproxyContainer) {
      console.error('❌ No running HAProxy container found with mini-infra.service=haproxy label');
      console.log('\nTo run this demo:');
      console.log('1. Ensure HAProxy is running with DataPlane API enabled');
      console.log('2. Label the container: docker label <container> mini-infra.service=haproxy');
      process.exit(1);
    }

    console.log(`✅ Found HAProxy container: ${haproxyContainer.name} (${haproxyContainer.id.slice(0, 12)})`);

    // Initialize HAProxy client
    console.log('\n3. Initializing HAProxy DataPlane client...');
    const client = new HAProxyDataPlaneClient();
    await client.initialize(haproxyContainer.id);

    const connectionInfo = client.getConnectionInfo();
    console.log(`✅ Connected to HAProxy DataPlane API: ${connectionInfo?.baseUrl}`);

    // List existing backends
    console.log('\n4. Listing existing backends...');
    const existingBackends = await client.listBackends();
    console.log(`📋 Found ${existingBackends.length} existing backends:`);
    existingBackends.forEach(backend => {
      console.log(`   - ${backend.name} (${backend.mode})`);
    });

    // Demo backend name
    const demoBackendName = 'demo-app-backend';

    // Create a demo backend
    console.log('\n5. Creating demo backend...');
    try {
      await client.createBackend({
        name: demoBackendName,
        mode: 'http',
        balance: 'roundrobin',
        check_timeout: 5000,
        connect_timeout: 3000
      });
      console.log(`✅ Created backend: ${demoBackendName}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('already exists')) {
        console.log(`ℹ️  Backend ${demoBackendName} already exists, continuing...`);
      } else {
        throw error;
      }
    }

    // Add a demo server
    console.log('\n6. Adding demo server to backend...');
    const demoServerName = 'demo-server-1';

    try {
      await client.addServer(demoBackendName, {
        name: demoServerName,
        address: '127.0.0.1',
        port: 3000,
        check: 'enabled',
        check_path: '/health',
        inter: 2000,
        rise: 2,
        fall: 3,
        weight: 100,
        enabled: false // Start disabled for safety
      });
      console.log(`✅ Added server: ${demoServerName}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('already exists')) {
        console.log(`ℹ️  Server ${demoServerName} already exists, continuing...`);
      } else {
        throw error;
      }
    }

    // Demonstrate server management
    console.log('\n7. Demonstrating server management...');

    // Enable server
    await client.enableServer(demoBackendName, demoServerName);
    console.log(`✅ Enabled server: ${demoServerName}`);

    // Check server stats
    const serverStats = await client.getServerStats(demoBackendName, demoServerName);
    if (serverStats) {
      console.log(`📊 Server stats: ${serverStats.status}, sessions: ${serverStats.current_sessions}/${serverStats.max_sessions}`);
    }

    // Set server to maintenance
    await client.setServerState(demoBackendName, demoServerName, 'maint');
    console.log(`🔧 Set server to maintenance mode`);

    // Get backend stats
    const backendStats = await client.getBackendStats(demoBackendName);
    if (backendStats) {
      console.log(`📊 Backend stats: ${backendStats.status}, active servers: ${backendStats.act_servers}`);
    }

    // Demonstrate transaction management
    console.log('\n8. Demonstrating transaction management...');
    const transactionId = await client.beginTransaction();
    console.log(`📝 Started transaction: ${transactionId}`);

    // We could make configuration changes here within the transaction

    await client.commitTransaction(transactionId);
    console.log(`✅ Committed transaction: ${transactionId}`);

    // Cleanup demo resources
    console.log('\n9. Cleaning up demo resources...');
    try {
      await client.deleteServer(demoBackendName, demoServerName);
      console.log(`🗑️  Deleted demo server: ${demoServerName}`);

      await client.deleteBackend(demoBackendName);
      console.log(`🗑️  Deleted demo backend: ${demoBackendName}`);
    } catch (error) {
      console.warn(`⚠️  Cleanup warning: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    console.log('\n🎉 Demo completed successfully!');
    console.log('\nThe HAProxy DataPlane client provides the following capabilities:');
    console.log('✅ Automatic HAProxy container discovery');
    console.log('✅ Backend management (create, delete, list)');
    console.log('✅ Server management (add, enable/disable, delete)');
    console.log('✅ Real-time statistics monitoring');
    console.log('✅ Transaction-based configuration changes');
    console.log('✅ Frontend and bind management');
    console.log('✅ Comprehensive error handling');

  } catch (error) {
    console.error('❌ Demo failed:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

// Run the demo
if (require.main === module) {
  demonstrateHAProxyClient().catch(console.error);
}

export { demonstrateHAProxyClient };