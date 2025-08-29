// Test the actual Docker service implementation
require('dotenv').config();

async function testDockerService() {
  console.log('Testing Docker Service implementation...\n');
  
  // Clear module cache to ensure fresh import
  delete require.cache[require.resolve('./dist/server/src/services/docker.js')];
  delete require.cache[require.resolve('./dist/server/src/lib/config.js')];
  
  const DockerService = require('./dist/server/src/services/docker.js').default;
  
  try {
    const dockerService = DockerService.getInstance();
    
    console.log('✓ Docker service instance created');
    
    // Initialize the service
    await dockerService.initialize();
    console.log('✓ Docker service initialized');
    
    // Check connection
    const isConnected = dockerService.isConnected();
    console.log(`✓ Connection status: ${isConnected ? 'Connected' : 'Not connected'}`);
    
    if (isConnected) {
      // Try listing containers
      const containers = await dockerService.listContainers();
      console.log(`✓ Listed ${containers.length} containers`);
      
      // Show first few containers
      containers.slice(0, 3).forEach(container => {
        console.log(`  - ${container.name} (${container.status})`);
      });
    }
    
  } catch (error) {
    console.error('✗ Error:', error.message);
    console.error('Stack:', error.stack);
  }
}

testDockerService().catch(console.error);