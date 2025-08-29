const Docker = require('dockerode');

async function testDirect() {
  console.log('Testing direct Docker connection...\n');
  
  // Test with the correct Windows pipe
  const docker = new Docker({ socketPath: '//./pipe/docker_engine' });
  
  try {
    // Test ping
    const pingResult = await docker.ping();
    console.log('✓ Ping successful:', pingResult);
    
    // Test version
    const version = await docker.version();
    console.log('✓ Docker version:', version.Version);
    console.log('  API version:', version.ApiVersion);
    
    // Test info
    const info = await docker.info();
    console.log('✓ Docker info:');
    console.log('  Containers:', info.Containers);
    console.log('  Images:', info.Images);
    console.log('  Server Version:', info.ServerVersion);
    
  } catch (error) {
    console.error('✗ Error:', error.message);
    if (error.statusCode) {
      console.error('  Status code:', error.statusCode);
    }
  }
}

testDirect().catch(console.error);