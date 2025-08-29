const Docker = require('dockerode');

// Test different connection methods
async function testConnection() {
  console.log('Testing Docker connection...\n');
  
  // Try Windows named pipe
  if (process.platform === 'win32') {
    try {
      const docker1 = new Docker({ socketPath: 'npipe:////./pipe/dockerDesktopLinuxEngine' });
      const info1 = await docker1.info();
      console.log('✓ Connected via npipe:////./pipe/dockerDesktopLinuxEngine');
      console.log(`  Docker version: ${info1.ServerVersion}`);
      console.log(`  API version: ${await docker1.version().then(v => v.ApiVersion)}`);
      return;
    } catch (e) {
      console.log('✗ Failed to connect via dockerDesktopLinuxEngine:', e.message);
    }
    
    try {
      const docker2 = new Docker({ socketPath: '//./pipe/docker_engine' });
      const info2 = await docker2.info();
      console.log('✓ Connected via //./pipe/docker_engine');
      console.log(`  Docker version: ${info2.ServerVersion}`);
      return;
    } catch (e) {
      console.log('✗ Failed to connect via docker_engine:', e.message);
    }
  }
  
  // Try Unix socket
  try {
    const docker3 = new Docker({ socketPath: '/var/run/docker.sock' });
    const info3 = await docker3.info();
    console.log('✓ Connected via /var/run/docker.sock');
    console.log(`  Docker version: ${info3.ServerVersion}`);
  } catch (e) {
    console.log('✗ Failed to connect via /var/run/docker.sock:', e.message);
  }
  
  // Try default (no options)
  try {
    const docker4 = new Docker();
    const info4 = await docker4.info();
    console.log('✓ Connected via default configuration');
    console.log(`  Docker version: ${info4.ServerVersion}`);
  } catch (e) {
    console.log('✗ Failed to connect via default:', e.message);
  }
}

testConnection().catch(console.error);