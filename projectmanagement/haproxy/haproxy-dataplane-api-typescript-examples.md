# HAProxy Data Plane API - TypeScript/Node.js Examples

## Setup and Installation

### Required Packages
```bash
npm install axios
npm install --save-dev @types/node typescript

# Optional packages for enhanced functionality
npm install winston  # For logging
npm install retry    # For retry logic
npm install zod      # For response validation
```

### TypeScript Configuration
```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true
  }
}
```

## Core TypeScript Client Implementation

### Type Definitions
```typescript
// types/haproxy.types.ts

export interface HAProxyConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  secure?: boolean;
  timeout?: number;
}

export interface Backend {
  name: string;
  mode: 'http' | 'tcp';
  balance?: {
    algorithm: 'roundrobin' | 'leastconn' | 'first' | 'source' | 'uri' | 'hdr' | 'random';
  };
  forwardfor?: {
    enabled: boolean;
  };
}

export interface Server {
  name: string;
  address: string;
  port: number;
  check?: 'enabled' | 'disabled';
  weight?: number;
  maxconn?: number;
  backup?: boolean;
  ssl?: boolean;
  verify?: 'none' | 'required';
}

export interface HealthCheck {
  enabled: boolean;
  interval?: number;
  timeout?: number;
  rise?: number;
  fall?: number;
  type?: 'tcp' | 'http' | 'ssl';
  http_check_method?: 'GET' | 'HEAD' | 'POST';
  http_check_path?: string;
  http_check_expect?: string;
}

export interface Transaction {
  id: string;
  status: string;
  version: number;
}

export interface ServerRuntime {
  admin_state: 'ready' | 'maint' | 'drain';
  operational_state: 'up' | 'down' | 'stopping';
  weight?: number;
}

export interface Version {
  version: number;
}

export interface ApiResponse<T> {
  data: T;
  version?: number;
}

export interface ErrorResponse {
  code: number;
  message: string;
}
```

### Main Client Class
```typescript
// haproxy-client.ts

import axios, { AxiosInstance, AxiosError } from 'axios';
import { HAProxyConfig, Backend, Server, Transaction, ServerRuntime, Version } from './types/haproxy.types';

export class HAProxyDataPlaneClient {
  private client: AxiosInstance;
  private baseURL: string;
  
  constructor(private config: HAProxyConfig) {
    const protocol = config.secure ? 'https' : 'http';
    this.baseURL = `${protocol}://${config.host}:${config.port}/v2`;
    
    this.client = axios.create({
      baseURL: this.baseURL,
      auth: {
        username: config.username,
        password: config.password
      },
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: config.timeout || 30000
    });
    
    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      response => response,
      this.handleError
    );
  }
  
  private handleError = (error: AxiosError): Promise<never> => {
    if (error.response) {
      const status = error.response.status;
      const message = (error.response.data as any)?.message || error.message;
      
      switch (status) {
        case 409:
          throw new Error(`Version conflict: ${message}. Please retry with the latest version.`);
        case 404:
          throw new Error(`Resource not found: ${message}`);
        case 401:
          throw new Error(`Authentication failed: ${message}`);
        case 400:
          throw new Error(`Bad request: ${message}`);
        default:
          throw new Error(`API Error (${status}): ${message}`);
      }
    }
    throw new Error(`Network error: ${error.message}`);
  }
  
  // Version Management
  async getVersion(): Promise<number> {
    const response = await this.client.get<Version>('/services/haproxy/configuration/version');
    return response.data.version;
  }
  
  // Backend Management
  async getBackends(): Promise<Backend[]> {
    const response = await this.client.get<Backend[]>('/services/haproxy/configuration/backends');
    return response.data;
  }
  
  async getBackend(name: string): Promise<Backend> {
    const response = await this.client.get<Backend>(`/services/haproxy/configuration/backends/${name}`);
    return response.data;
  }
  
  async createBackend(backend: Backend): Promise<Backend> {
    const version = await this.getVersion();
    const response = await this.client.post<Backend>(
      `/services/haproxy/configuration/backends?version=${version}`,
      backend
    );
    return response.data;
  }
  
  async updateBackend(name: string, backend: Partial<Backend>): Promise<Backend> {
    const version = await this.getVersion();
    const response = await this.client.put<Backend>(
      `/services/haproxy/configuration/backends/${name}?version=${version}`,
      backend
    );
    return response.data;
  }
  
  async deleteBackend(name: string): Promise<void> {
    const version = await this.getVersion();
    await this.client.delete(`/services/haproxy/configuration/backends/${name}?version=${version}`);
  }
  
  // Server Management
  async getServers(backend: string): Promise<Server[]> {
    const response = await this.client.get<Server[]>(
      `/services/haproxy/configuration/servers?backend=${backend}`
    );
    return response.data;
  }
  
  async addServer(backend: string, server: Server): Promise<Server> {
    const version = await this.getVersion();
    const response = await this.client.post<Server>(
      `/services/haproxy/configuration/servers?backend=${backend}&version=${version}`,
      server
    );
    return response.data;
  }
  
  async updateServer(backend: string, serverName: string, server: Partial<Server>): Promise<Server> {
    const version = await this.getVersion();
    const response = await this.client.put<Server>(
      `/services/haproxy/configuration/servers/${serverName}?backend=${backend}&version=${version}`,
      server
    );
    return response.data;
  }
  
  async deleteServer(backend: string, serverName: string): Promise<void> {
    const version = await this.getVersion();
    await this.client.delete(
      `/services/haproxy/configuration/servers/${serverName}?backend=${backend}&version=${version}`
    );
  }
  
  // Runtime Server Management
  async getServerRuntime(backend: string, server: string): Promise<ServerRuntime> {
    const response = await this.client.get<ServerRuntime>(
      `/services/haproxy/runtime/servers/${server}?backend=${backend}`
    );
    return response.data;
  }
  
  async updateServerRuntime(backend: string, server: string, state: Partial<ServerRuntime>): Promise<void> {
    await this.client.put(
      `/services/haproxy/runtime/servers/${server}?backend=${backend}`,
      state
    );
  }
  
  // Transaction Management
  async createTransaction(): Promise<Transaction> {
    const version = await this.getVersion();
    const response = await this.client.post<Transaction>(
      `/services/haproxy/transactions?version=${version}`
    );
    return response.data;
  }
  
  async commitTransaction(transactionId: string): Promise<void> {
    await this.client.put(`/services/haproxy/transactions/${transactionId}`);
  }
  
  async deleteTransaction(transactionId: string): Promise<void> {
    await this.client.delete(`/services/haproxy/transactions/${transactionId}`);
  }
}
```

## Advanced Features

### Transaction Manager with Automatic Rollback
```typescript
// transaction-manager.ts

export class TransactionManager {
  constructor(private client: HAProxyDataPlaneClient) {}
  
  async executeInTransaction<T>(
    operations: (transactionId: string) => Promise<T>
  ): Promise<T> {
    const transaction = await this.client.createTransaction();
    
    try {
      const result = await operations(transaction.id);
      await this.client.commitTransaction(transaction.id);
      return result;
    } catch (error) {
      await this.client.deleteTransaction(transaction.id);
      throw error;
    }
  }
  
  // Helper method to add transaction_id to requests
  withTransaction(transactionId: string, url: string): string {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}transaction_id=${transactionId}`;
  }
}

// Usage example
async function atomicBackendUpdate(client: HAProxyDataPlaneClient) {
  const tm = new TransactionManager(client);
  
  await tm.executeInTransaction(async (transactionId) => {
    // All operations here will be atomic
    await client.createBackend({
      name: 'new_backend',
      mode: 'http',
      balance: { algorithm: 'roundrobin' }
    });
    
    await client.addServer('new_backend', {
      name: 'server1',
      address: '10.0.0.1',
      port: 8080,
      check: 'enabled'
    });
    
    await client.addServer('new_backend', {
      name: 'server2',
      address: '10.0.0.2',
      port: 8080,
      check: 'enabled'
    });
  });
}
```

### Retry Logic with Exponential Backoff
```typescript
// retry-client.ts

export class RetryableHAProxyClient extends HAProxyDataPlaneClient {
  private maxRetries = 3;
  private baseDelay = 1000;
  
  private async withRetry<T>(
    operation: () => Promise<T>,
    retries = this.maxRetries
  ): Promise<T> {
    try {
      return await operation();
    } catch (error: any) {
      if (retries > 0 && error.message?.includes('Version conflict')) {
        const delay = this.baseDelay * Math.pow(2, this.maxRetries - retries);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.withRetry(operation, retries - 1);
      }
      throw error;
    }
  }
  
  async createBackend(backend: Backend): Promise<Backend> {
    return this.withRetry(() => super.createBackend(backend));
  }
  
  async addServer(backend: string, server: Server): Promise<Server> {
    return this.withRetry(() => super.addServer(backend, server));
  }
}
```

### Health Check Monitor
```typescript
// health-monitor.ts

import { EventEmitter } from 'events';

export class HealthCheckMonitor extends EventEmitter {
  private intervalId?: NodeJS.Timer;
  private serverStates = new Map<string, string>();
  
  constructor(
    private client: HAProxyDataPlaneClient,
    private checkInterval = 5000
  ) {
    super();
  }
  
  async startMonitoring(backends: string[]): Promise<void> {
    this.intervalId = setInterval(async () => {
      for (const backend of backends) {
        await this.checkBackend(backend);
      }
    }, this.checkInterval);
  }
  
  private async checkBackend(backend: string): Promise<void> {
    try {
      const servers = await this.client.getServers(backend);
      
      for (const server of servers) {
        const runtime = await this.client.getServerRuntime(backend, server.name);
        const key = `${backend}:${server.name}`;
        const previousState = this.serverStates.get(key);
        
        if (previousState !== runtime.operational_state) {
          this.serverStates.set(key, runtime.operational_state);
          this.emit('stateChange', {
            backend,
            server: server.name,
            previousState,
            currentState: runtime.operational_state,
            timestamp: new Date()
          });
        }
      }
    } catch (error) {
      this.emit('error', { backend, error });
    }
  }
  
  stopMonitoring(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }
}

// Usage
const monitor = new HealthCheckMonitor(client);

monitor.on('stateChange', (event) => {
  console.log(`Server ${event.server} in ${event.backend} changed from ${event.previousState} to ${event.currentState}`);
});

monitor.on('error', (event) => {
  console.error(`Error monitoring ${event.backend}:`, event.error);
});

await monitor.startMonitoring(['web_backend', 'api_backend']);
```

## Practical Use Cases

### 1. Blue-Green Deployment
```typescript
// blue-green-deployment.ts

export class BlueGreenDeployment {
  constructor(private client: HAProxyDataPlaneClient) {}
  
  async deploy(
    frontendName: string,
    blueBackend: string,
    greenBackend: string,
    healthCheckPath = '/health'
  ): Promise<void> {
    console.log('Starting blue-green deployment...');
    
    // Step 1: Ensure green backend servers are healthy
    await this.waitForHealthy(greenBackend, healthCheckPath);
    
    // Step 2: Gradually shift traffic
    await this.shiftTraffic(blueBackend, greenBackend);
    
    // Step 3: Drain connections from blue backend
    await this.drainBackend(blueBackend);
    
    console.log('Blue-green deployment completed successfully');
  }
  
  private async waitForHealthy(backend: string, healthPath: string, maxWait = 60000): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWait) {
      const servers = await this.client.getServers(backend);
      const healthyCount = await this.countHealthyServers(backend, servers);
      
      if (healthyCount === servers.length) {
        console.log(`All ${servers.length} servers in ${backend} are healthy`);
        return;
      }
      
      console.log(`Waiting for servers: ${healthyCount}/${servers.length} healthy`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    throw new Error(`Timeout waiting for ${backend} to become healthy`);
  }
  
  private async countHealthyServers(backend: string, servers: Server[]): Promise<number> {
    let healthy = 0;
    
    for (const server of servers) {
      const runtime = await this.client.getServerRuntime(backend, server.name);
      if (runtime.operational_state === 'up') {
        healthy++;
      }
    }
    
    return healthy;
  }
  
  private async shiftTraffic(fromBackend: string, toBackend: string): Promise<void> {
    const steps = [
      { from: 100, to: 0 },
      { from: 75, to: 25 },
      { from: 50, to: 50 },
      { from: 25, to: 75 },
      { from: 0, to: 100 }
    ];
    
    for (const step of steps) {
      await this.setBackendWeights(fromBackend, step.from);
      await this.setBackendWeights(toBackend, step.to);
      
      console.log(`Traffic distribution: ${fromBackend}=${step.from}%, ${toBackend}=${step.to}%`);
      
      // Wait for traffic to stabilize
      await new Promise(resolve => setTimeout(resolve, 10000));
      
      // Check for errors
      const greenHealthy = await this.countHealthyServers(
        toBackend,
        await this.client.getServers(toBackend)
      );
      
      if (greenHealthy === 0) {
        // Rollback
        console.error('Green backend unhealthy, rolling back...');
        await this.setBackendWeights(fromBackend, 100);
        await this.setBackendWeights(toBackend, 0);
        throw new Error('Deployment failed: green backend became unhealthy');
      }
    }
  }
  
  private async setBackendWeights(backend: string, weight: number): Promise<void> {
    const servers = await this.client.getServers(backend);
    
    for (const server of servers) {
      await this.client.updateServerRuntime(backend, server.name, { weight });
    }
  }
  
  private async drainBackend(backend: string): Promise<void> {
    const servers = await this.client.getServers(backend);
    
    for (const server of servers) {
      await this.client.updateServerRuntime(backend, server.name, {
        admin_state: 'drain'
      });
    }
    
    console.log(`Backend ${backend} set to drain mode`);
  }
}
```

### 2. Auto-Scaling Manager
```typescript
// auto-scaler.ts

interface ScalingPolicy {
  backend: string;
  minServers: number;
  maxServers: number;
  targetCpuPercent?: number;
  targetConnectionsPerServer?: number;
  scaleUpThreshold: number;
  scaleDownThreshold: number;
  cooldownSeconds: number;
}

export class AutoScaler {
  private lastScaleTime = new Map<string, Date>();
  
  constructor(
    private client: HAProxyDataPlaneClient,
    private serverProvider: (backend: string) => Promise<Server>
  ) {}
  
  async evaluateScaling(policy: ScalingPolicy, currentMetrics: any): Promise<void> {
    const backend = policy.backend;
    const lastScale = this.lastScaleTime.get(backend);
    
    // Check cooldown period
    if (lastScale && Date.now() - lastScale.getTime() < policy.cooldownSeconds * 1000) {
      return;
    }
    
    const servers = await this.client.getServers(backend);
    const currentCount = servers.filter(s => s.check === 'enabled').length;
    
    if (currentMetrics.cpuPercent > policy.scaleUpThreshold && currentCount < policy.maxServers) {
      await this.scaleUp(backend, policy);
    } else if (currentMetrics.cpuPercent < policy.scaleDownThreshold && currentCount > policy.minServers) {
      await this.scaleDown(backend, policy);
    }
  }
  
  private async scaleUp(backend: string, policy: ScalingPolicy): Promise<void> {
    console.log(`Scaling up ${backend}`);
    
    const newServer = await this.serverProvider(backend);
    await this.client.addServer(backend, newServer);
    
    this.lastScaleTime.set(backend, new Date());
    
    console.log(`Added server ${newServer.name} to ${backend}`);
  }
  
  private async scaleDown(backend: string, policy: ScalingPolicy): Promise<void> {
    console.log(`Scaling down ${backend}`);
    
    const servers = await this.client.getServers(backend);
    const activeServers = servers.filter(s => s.check === 'enabled');
    
    if (activeServers.length <= policy.minServers) {
      return;
    }
    
    // Find server with least connections (would need metrics API)
    const serverToRemove = activeServers[activeServers.length - 1];
    
    // Drain connections first
    await this.client.updateServerRuntime(backend, serverToRemove.name, {
      admin_state: 'drain'
    });
    
    // Wait for connections to drain
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    // Remove server
    await this.client.deleteServer(backend, serverToRemove.name);
    
    this.lastScaleTime.set(backend, new Date());
    
    console.log(`Removed server ${serverToRemove.name} from ${backend}`);
  }
}
```

### 3. Service Discovery Integration
```typescript
// service-discovery.ts

interface ServiceInstance {
  id: string;
  address: string;
  port: number;
  tags?: string[];
  metadata?: Record<string, string>;
}

export class ServiceDiscoverySync {
  private syncInterval?: NodeJS.Timer;
  
  constructor(
    private client: HAProxyDataPlaneClient,
    private discoveryClient: any // Could be Consul, Kubernetes, etc.
  ) {}
  
  async startSync(
    serviceName: string,
    backendName: string,
    interval = 10000
  ): Promise<void> {
    // Initial sync
    await this.syncServices(serviceName, backendName);
    
    // Periodic sync
    this.syncInterval = setInterval(async () => {
      await this.syncServices(serviceName, backendName);
    }, interval);
  }
  
  private async syncServices(serviceName: string, backendName: string): Promise<void> {
    try {
      // Get services from discovery
      const discoveredServices = await this.discoveryClient.getServices(serviceName);
      
      // Get current HAProxy servers
      const currentServers = await this.client.getServers(backendName);
      
      // Calculate differences
      const toAdd = this.findServersToAdd(discoveredServices, currentServers);
      const toRemove = this.findServersToRemove(discoveredServices, currentServers);
      const toUpdate = this.findServersToUpdate(discoveredServices, currentServers);
      
      // Apply changes
      for (const server of toAdd) {
        await this.addServerFromDiscovery(backendName, server);
      }
      
      for (const server of toRemove) {
        await this.removeServer(backendName, server);
      }
      
      for (const server of toUpdate) {
        await this.updateServerFromDiscovery(backendName, server);
      }
      
      if (toAdd.length || toRemove.length || toUpdate.length) {
        console.log(`Synced ${backendName}: +${toAdd.length} -${toRemove.length} ~${toUpdate.length}`);
      }
    } catch (error) {
      console.error(`Failed to sync ${serviceName} to ${backendName}:`, error);
    }
  }
  
  private findServersToAdd(discovered: ServiceInstance[], current: Server[]): ServiceInstance[] {
    return discovered.filter(d => 
      !current.find(c => c.name === this.getServerName(d))
    );
  }
  
  private findServersToRemove(discovered: ServiceInstance[], current: Server[]): Server[] {
    return current.filter(c => 
      !discovered.find(d => this.getServerName(d) === c.name)
    );
  }
  
  private findServersToUpdate(discovered: ServiceInstance[], current: Server[]): ServiceInstance[] {
    return discovered.filter(d => {
      const currentServer = current.find(c => c.name === this.getServerName(d));
      return currentServer && (
        currentServer.address !== d.address ||
        currentServer.port !== d.port
      );
    });
  }
  
  private getServerName(instance: ServiceInstance): string {
    return instance.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  }
  
  private async addServerFromDiscovery(backend: string, instance: ServiceInstance): Promise<void> {
    await this.client.addServer(backend, {
      name: this.getServerName(instance),
      address: instance.address,
      port: instance.port,
      check: 'enabled',
      weight: 100
    });
  }
  
  private async removeServer(backend: string, server: Server): Promise<void> {
    // Drain first
    await this.client.updateServerRuntime(backend, server.name, {
      admin_state: 'drain'
    });
    
    // Wait for connections to drain
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Remove
    await this.client.deleteServer(backend, server.name);
  }
  
  private async updateServerFromDiscovery(backend: string, instance: ServiceInstance): Promise<void> {
    await this.client.updateServer(backend, this.getServerName(instance), {
      address: instance.address,
      port: instance.port
    });
  }
  
  stopSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = undefined;
    }
  }
}
```

### 4. Circuit Breaker Implementation
```typescript
// circuit-breaker.ts

interface CircuitBreakerConfig {
  backend: string;
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
  halfOpenMaxCalls: number;
}

enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

export class CircuitBreaker {
  private state = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private nextAttempt?: Date;
  private halfOpenCalls = 0;
  
  constructor(
    private client: HAProxyDataPlaneClient,
    private config: CircuitBreakerConfig
  ) {}
  
  async monitorBackend(): Promise<void> {
    const servers = await this.client.getServers(this.config.backend);
    let healthyCount = 0;
    
    for (const server of servers) {
      const runtime = await this.client.getServerRuntime(this.config.backend, server.name);
      if (runtime.operational_state === 'up') {
        healthyCount++;
      }
    }
    
    const healthPercent = (healthyCount / servers.length) * 100;
    
    switch (this.state) {
      case CircuitState.CLOSED:
        if (healthPercent < 50) {
          this.failures++;
          if (this.failures >= this.config.failureThreshold) {
            await this.openCircuit();
          }
        } else {
          this.failures = 0;
        }
        break;
        
      case CircuitState.OPEN:
        if (this.nextAttempt && new Date() >= this.nextAttempt) {
          await this.halfOpenCircuit();
        }
        break;
        
      case CircuitState.HALF_OPEN:
        if (healthPercent >= 80) {
          this.successes++;
          if (this.successes >= this.config.successThreshold) {
            await this.closeCircuit();
          }
        } else {
          await this.openCircuit();
        }
        break;
    }
  }
  
  private async openCircuit(): Promise<void> {
    console.log(`Circuit OPEN for ${this.config.backend}`);
    this.state = CircuitState.OPEN;
    this.failures = 0;
    this.successes = 0;
    this.nextAttempt = new Date(Date.now() + this.config.timeout);
    
    // Disable all servers in backend
    const servers = await this.client.getServers(this.config.backend);
    for (const server of servers) {
      await this.client.updateServerRuntime(this.config.backend, server.name, {
        admin_state: 'maint'
      });
    }
  }
  
  private async halfOpenCircuit(): Promise<void> {
    console.log(`Circuit HALF-OPEN for ${this.config.backend}`);
    this.state = CircuitState.HALF_OPEN;
    this.halfOpenCalls = 0;
    
    // Enable one server for testing
    const servers = await this.client.getServers(this.config.backend);
    if (servers.length > 0) {
      await this.client.updateServerRuntime(this.config.backend, servers[0].name, {
        admin_state: 'ready'
      });
    }
  }
  
  private async closeCircuit(): Promise<void> {
    console.log(`Circuit CLOSED for ${this.config.backend}`);
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    
    // Enable all servers
    const servers = await this.client.getServers(this.config.backend);
    for (const server of servers) {
      await this.client.updateServerRuntime(this.config.backend, server.name, {
        admin_state: 'ready'
      });
    }
  }
  
  getState(): CircuitState {
    return this.state;
  }
}
```

## Testing

### Unit Tests with Jest
```typescript
// __tests__/haproxy-client.test.ts

import { HAProxyDataPlaneClient } from '../haproxy-client';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('HAProxyDataPlaneClient', () => {
  let client: HAProxyDataPlaneClient;
  
  beforeEach(() => {
    mockedAxios.create.mockReturnValue({
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
      interceptors: {
        response: {
          use: jest.fn()
        }
      }
    } as any);
    
    client = new HAProxyDataPlaneClient({
      host: 'localhost',
      port: 5555,
      username: 'admin',
      password: 'password'
    });
  });
  
  describe('Backend Management', () => {
    test('should create a backend', async () => {
      const mockClient = (client as any).client;
      mockClient.get.mockResolvedValueOnce({ data: { version: 1 } });
      mockClient.post.mockResolvedValueOnce({
        data: { name: 'test_backend', mode: 'http' }
      });
      
      const backend = await client.createBackend({
        name: 'test_backend',
        mode: 'http'
      });
      
      expect(backend.name).toBe('test_backend');
      expect(mockClient.post).toHaveBeenCalledWith(
        '/services/haproxy/configuration/backends?version=1',
        expect.objectContaining({ name: 'test_backend' })
      );
    });
    
    test('should handle version conflicts', async () => {
      const mockClient = (client as any).client;
      mockClient.get.mockResolvedValueOnce({ data: { version: 1 } });
      mockClient.post.mockRejectedValueOnce({
        response: { status: 409, data: { message: 'Version conflict' } }
      });
      
      await expect(client.createBackend({
        name: 'test_backend',
        mode: 'http'
      })).rejects.toThrow('Version conflict');
    });
  });
});
```

### Integration Tests
```typescript
// __tests__/integration.test.ts

import { HAProxyDataPlaneClient } from '../haproxy-client';
import { BlueGreenDeployment } from '../blue-green-deployment';

describe('Integration Tests', () => {
  let client: HAProxyDataPlaneClient;
  
  beforeAll(() => {
    client = new HAProxyDataPlaneClient({
      host: process.env.HAPROXY_HOST || 'localhost',
      port: parseInt(process.env.HAPROXY_PORT || '5555'),
      username: process.env.HAPROXY_USER || 'admin',
      password: process.env.HAPROXY_PASS || 'password'
    });
  });
  
  test('Blue-Green Deployment', async () => {
    // Setup test backends
    await client.createBackend({
      name: 'test_blue',
      mode: 'http'
    });
    
    await client.createBackend({
      name: 'test_green',
      mode: 'http'
    });
    
    // Add servers
    await client.addServer('test_blue', {
      name: 'blue_server',
      address: '10.0.0.1',
      port: 8080
    });
    
    await client.addServer('test_green', {
      name: 'green_server',
      address: '10.0.0.2',
      port: 8080
    });
    
    // Execute deployment
    const deployment = new BlueGreenDeployment(client);
    await deployment.deploy('test_frontend', 'test_blue', 'test_green');
    
    // Verify final state
    const blueRuntime = await client.getServerRuntime('test_blue', 'blue_server');
    expect(blueRuntime.admin_state).toBe('drain');
    
    // Cleanup
    await client.deleteBackend('test_blue');
    await client.deleteBackend('test_green');
  }, 60000);
});
```

## Error Handling and Logging

### Winston Logger Integration
```typescript
// logger.ts

import winston from 'winston';

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'haproxy-api.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Enhanced client with logging
export class LoggedHAProxyClient extends HAProxyDataPlaneClient {
  async createBackend(backend: Backend): Promise<Backend> {
    logger.info('Creating backend', { backend });
    try {
      const result = await super.createBackend(backend);
      logger.info('Backend created successfully', { backend: backend.name });
      return result;
    } catch (error) {
      logger.error('Failed to create backend', { backend: backend.name, error });
      throw error;
    }
  }
}
```

## Environment Configuration

### .env file
```env
HAPROXY_HOST=localhost
HAPROXY_PORT=5555
HAPROXY_USER=admin
HAPROXY_PASSWORD=secure_password
HAPROXY_SECURE=false
HAPROXY_TIMEOUT=30000
```

### Config loader
```typescript
// config.ts

import dotenv from 'dotenv';

dotenv.config();

export const config = {
  haproxy: {
    host: process.env.HAPROXY_HOST || 'localhost',
    port: parseInt(process.env.HAPROXY_PORT || '5555'),
    username: process.env.HAPROXY_USER || 'admin',
    password: process.env.HAPROXY_PASSWORD || '',
    secure: process.env.HAPROXY_SECURE === 'true',
    timeout: parseInt(process.env.HAPROXY_TIMEOUT || '30000')
  }
};
```

## CLI Tool Example

```typescript
// cli.ts

import { Command } from 'commander';
import { HAProxyDataPlaneClient } from './haproxy-client';
import { config } from './config';

const program = new Command();
const client = new HAProxyDataPlaneClient(config.haproxy);

program
  .name('haproxy-cli')
  .description('CLI for HAProxy Data Plane API')
  .version('1.0.0');

program
  .command('list-backends')
  .description('List all backends')
  .action(async () => {
    const backends = await client.getBackends();
    console.table(backends.map(b => ({
      Name: b.name,
      Mode: b.mode,
      Algorithm: b.balance?.algorithm || 'N/A'
    })));
  });

program
  .command('add-server <backend> <name> <address> <port>')
  .description('Add a server to a backend')
  .option('-w, --weight <weight>', 'Server weight', '100')
  .action(async (backend, name, address, port, options) => {
    await client.addServer(backend, {
      name,
      address,
      port: parseInt(port),
      weight: parseInt(options.weight),
      check: 'enabled'
    });
    console.log(`Server ${name} added to ${backend}`);
  });

program
  .command('drain-server <backend> <server>')
  .description('Put server in drain mode')
  .action(async (backend, server) => {
    await client.updateServerRuntime(backend, server, {
      admin_state: 'drain'
    });
    console.log(`Server ${server} in ${backend} is now draining`);
  });

program.parse();
```

## Package.json Scripts

```json
{
  "name": "haproxy-dataplane-client",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc",
    "dev": "ts-node src/index.ts",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage",
    "lint": "eslint src/**/*.ts",
    "cli": "ts-node src/cli.ts"
  },
  "dependencies": {
    "axios": "^1.6.0",
    "winston": "^3.11.0",
    "commander": "^11.1.0",
    "dotenv": "^16.3.1"
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "@types/jest": "^29.5.0",
    "typescript": "^5.3.0",
    "ts-node": "^10.9.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "@typescript-eslint/eslint-plugin": "^6.14.0",
    "@typescript-eslint/parser": "^6.14.0",
    "eslint": "^8.55.0"
  }
}
```

This comprehensive TypeScript/Node.js implementation provides a robust foundation for working with the HAProxy Data Plane API, including advanced features like blue-green deployments, auto-scaling, service discovery, and circuit breakers.