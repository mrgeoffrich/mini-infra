# HAProxy Data Plane API Research

## Overview

The HAProxy Data Plane API is a RESTful service that runs as a sidecar process alongside HAProxy, providing HTTP endpoints for dynamically configuring and managing HAProxy load balancers. It enables programmatic configuration without requiring direct file access or HAProxy restarts.

### Key Features

- **Dynamic Configuration**: Configure frontends, backends, servers, ACLs, and routing rules via HTTP commands
- **Runtime Management**: Enable/disable servers, adjust weights, manage health checks without restarts
- **Transaction Support**: Atomic configuration changes with rollback capability
- **OpenAPI Specification**: Built on OpenAPI 2.0 (Swagger) with auto-generated documentation
- **Version Control**: Optimistic concurrency control prevents configuration conflicts

## Requirements

- **HAProxy Version**: 1.9.0 or higher (Data Plane API added in HAProxy 2.0)
- **Authentication**: Basic authentication via HAProxy userlist
- **Supported Algorithms**: MD5, SHA-256, SHA-512 for secure passwords

## Installation and Setup

### Starting the Data Plane API

#### Using Program Directive (HAProxy 2.0+)
Add to HAProxy configuration:
```
program api
    command /usr/local/bin/dataplaneapi -f /etc/haproxy/dataplaneapi.yml
    no option start-on-reload
```

#### Standalone Execution
```bash
# Using configuration file (recommended)
./dataplaneapi -f /etc/haproxy/dataplaneapi.yml

# Or using command-line arguments
./dataplaneapi \
  --host 0.0.0.0 \
  --port 5555 \
  --haproxy-bin /usr/sbin/haproxy \
  --config-file /etc/haproxy/haproxy.cfg \
  --reload-delay 5 \
  --reload-cmd "systemctl reload haproxy" \
  --restart-cmd "systemctl restart haproxy" \
  --userlist controller \
  --transaction-dir /tmp/haproxy
```

### Authentication Configuration

#### Option 1: Simple User Authentication (dataplaneapi.yml)
```yaml
dataplaneapi:
  user:
    - name: admin
      password: mypassword
      insecure: true  # For plain text password
```

#### Option 2: HAProxy Userlist Authentication
Add userlist to HAProxy configuration:
```
userlist controller
    user admin insecure-password mypassword
```

Then reference in dataplaneapi.yml:
```yaml
dataplaneapi:
  userlist:
    userlist: controller
    userlist_file: /etc/haproxy/haproxy.cfg
```

## API Documentation

### Built-in Documentation

- **Swagger UI**: `http://localhost:5555/v2/docs`
- **OpenAPI Spec**: `http://localhost:5555/v2/specification`
- **Version 1 Spec**: `http://localhost:5555/v1/specification`

### Testing Connection
```bash
curl -u admin:mypassword \
  -H "Content-Type: application/json" \
  "http://127.0.0.1:5555/v2/"
```

## Core API Endpoints

### Configuration Endpoints

#### Backends
- **GET** `/v2/services/haproxy/configuration/backends` - List all backends
- **POST** `/v2/services/haproxy/configuration/backends` - Create backend
- **GET** `/v2/services/haproxy/configuration/backends/{name}` - Get specific backend
- **PUT** `/v2/services/haproxy/configuration/backends/{name}` - Update backend
- **DELETE** `/v2/services/haproxy/configuration/backends/{name}` - Delete backend

#### Servers
- **GET** `/v2/services/haproxy/configuration/servers` - List servers
- **POST** `/v2/services/haproxy/configuration/servers` - Add server to backend
- **PUT** `/v2/services/haproxy/configuration/servers/{name}` - Update server
- **DELETE** `/v2/services/haproxy/configuration/servers/{name}` - Remove server

#### Frontends
- **GET** `/v2/services/haproxy/configuration/frontends` - List frontends
- **POST** `/v2/services/haproxy/configuration/frontends` - Create frontend

#### Global Configuration
- **GET** `/v2/services/haproxy/configuration/global` - Get global settings
- **PUT** `/v2/services/haproxy/configuration/global` - Update global settings

### Runtime Endpoints

- `/v2/services/haproxy/runtime/servers/{name}` - Server state management
- `/v2/services/haproxy/runtime/maps` - Map file operations
- `/v2/services/haproxy/runtime/stick-tables` - Stick table management

### Transaction Management

- **POST** `/v2/services/haproxy/transactions` - Create transaction
- **GET** `/v2/services/haproxy/transactions/{id}` - Get transaction status
- **PUT** `/v2/services/haproxy/transactions/{id}` - Commit transaction
- **DELETE** `/v2/services/haproxy/transactions/{id}` - Rollback transaction

## Transaction-Based Operations

Transactions ensure atomic configuration changes:

1. **Create Transaction**
   ```bash
   curl -X POST \
     -u admin:password \
     "http://localhost:5555/v2/services/haproxy/transactions?version=1"
   ```

2. **Make Changes** (include transaction ID in requests)
   ```bash
   curl -X POST \
     -u admin:password \
     -H "Content-Type: application/json" \
     -d '{"name":"web_servers","mode":"http"}' \
     "http://localhost:5555/v2/services/haproxy/configuration/backends?transaction_id=abc123"
   ```

3. **Commit Transaction**
   ```bash
   curl -X PUT \
     -u admin:password \
     "http://localhost:5555/v2/services/haproxy/transactions/abc123"
   ```

## Version Management

The API uses optimistic concurrency control:

1. **Get Current Version**
   ```bash
   curl -u admin:password \
     "http://localhost:5555/v2/services/haproxy/configuration/version"
   ```

2. **Include Version in Modifications**
   - Required for POST, PUT, DELETE operations
   - Prevents concurrent modification conflicts
   - Example: `?version=42`

## Python Client Examples

### Basic Connection
```python
import requests
from requests.auth import HTTPBasicAuth

class HAProxyDataPlaneAPI:
    def __init__(self, host, port, username, password):
        self.base_url = f"http://{host}:{port}/v2"
        self.auth = HTTPBasicAuth(username, password)
        self.headers = {"Content-Type": "application/json"}
    
    def get_version(self):
        response = requests.get(
            f"{self.base_url}/services/haproxy/configuration/version",
            auth=self.auth
        )
        return response.json()
```

### Backend Management
```python
def create_backend(self, name, mode="http", balance="roundrobin"):
    version = self.get_version()
    
    backend_data = {
        "name": name,
        "mode": mode,
        "balance": {
            "algorithm": balance
        }
    }
    
    response = requests.post(
        f"{self.base_url}/services/haproxy/configuration/backends?version={version}",
        auth=self.auth,
        headers=self.headers,
        json=backend_data
    )
    return response.json()

def add_server(self, backend, server_name, address, port):
    version = self.get_version()
    
    server_data = {
        "name": server_name,
        "address": address,
        "port": port,
        "check": "enabled",
        "weight": 100
    }
    
    response = requests.post(
        f"{self.base_url}/services/haproxy/configuration/servers?backend={backend}&version={version}",
        auth=self.auth,
        headers=self.headers,
        json=server_data
    )
    return response.json()
```

### Transaction Example
```python
def update_with_transaction(self):
    # Create transaction
    version = self.get_version()
    transaction = requests.post(
        f"{self.base_url}/services/haproxy/transactions?version={version}",
        auth=self.auth
    ).json()
    
    transaction_id = transaction["id"]
    
    try:
        # Make multiple changes
        # ... perform operations with transaction_id parameter
        
        # Commit transaction
        requests.put(
            f"{self.base_url}/services/haproxy/transactions/{transaction_id}",
            auth=self.auth
        )
    except Exception as e:
        # Rollback on error
        requests.delete(
            f"{self.base_url}/services/haproxy/transactions/{transaction_id}",
            auth=self.auth
        )
        raise
```

### Runtime Server Management
```python
def disable_server(self, backend, server):
    """Disable a server in a backend"""
    response = requests.put(
        f"{self.base_url}/services/haproxy/runtime/servers/{server}",
        auth=self.auth,
        headers=self.headers,
        json={
            "admin_state": "maint",
            "operational_state": "down"
        },
        params={"backend": backend}
    )
    return response.json()

def change_server_weight(self, backend, server, weight):
    """Adjust server weight for load balancing"""
    response = requests.put(
        f"{self.base_url}/services/haproxy/runtime/servers/{server}",
        auth=self.auth,
        headers=self.headers,
        json={"weight": weight},
        params={"backend": backend}
    )
    return response.json()
```

## Use Cases

### Dynamic Service Discovery
- Automatically add/remove servers based on service registry
- Integrate with Kubernetes, Consul, or custom discovery mechanisms

### Blue-Green Deployments
```python
def blue_green_switch(api, from_backend, to_backend):
    # Start transaction
    transaction_id = api.create_transaction()
    
    # Disable old backend servers
    for server in api.get_servers(from_backend):
        api.disable_server(from_backend, server["name"], transaction_id)
    
    # Enable new backend servers
    for server in api.get_servers(to_backend):
        api.enable_server(to_backend, server["name"], transaction_id)
    
    # Commit changes atomically
    api.commit_transaction(transaction_id)
```

### Automated Scaling
- Monitor server metrics and adjust weights dynamically
- Add/remove servers based on load patterns
- Implement circuit breaker patterns

### Health Check Management
```python
def configure_health_check(api, backend, check_config):
    version = api.get_version()
    
    health_check = {
        "check": {
            "enabled": True,
            "interval": 5000,  # 5 seconds
            "timeout": 3000,   # 3 seconds
            "rise": 2,         # successful checks to mark UP
            "fall": 3,         # failed checks to mark DOWN
            "type": "http",
            "http_check_method": "GET",
            "http_check_path": "/health"
        }
    }
    
    api.update_backend(backend, health_check, version)
```

## Best Practices

### 1. Version Management
- Always retrieve current version before modifications
- Handle version conflicts gracefully with retry logic
- Use transactions for related changes

### 2. Error Handling
```python
def safe_api_call(func):
    def wrapper(*args, **kwargs):
        try:
            response = func(*args, **kwargs)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 409:
                # Version conflict - retry with new version
                pass
            elif e.response.status_code == 404:
                # Resource not found
                pass
            raise
    return wrapper
```

### 3. Connection Pooling
```python
class HAProxyAPI:
    def __init__(self, host, port, username, password):
        self.session = requests.Session()
        self.session.auth = HTTPBasicAuth(username, password)
        self.session.headers.update({"Content-Type": "application/json"})
        # Connection pooling is handled automatically by requests.Session
```

### 4. Monitoring Integration
- Log all API operations for audit trails
- Monitor API response times
- Set up alerts for failed transactions

### 5. Security Considerations
- Use HTTPS in production environments
- Rotate API credentials regularly
- Implement rate limiting
- Restrict API access by IP/network
- Use certificate-based authentication when possible

## Limitations and Considerations

1. **Configuration File Sync**: All API changes are written back to the configuration file
2. **Restart Requirements**: Some global configuration changes may require restart
3. **Performance Impact**: Large configuration changes can temporarily impact performance
4. **Version Conflicts**: Multiple clients can cause version conflicts requiring retry logic
5. **Feature Coverage**: Not all HAProxy features may be exposed via API

## Alternative Approaches

### HAProxy Runtime API
- Socket-based interface for runtime changes only
- More limited scope but lower overhead
- Suitable for simple enable/disable operations

### Configuration Management Tools
- Ansible, Puppet, Chef for template-based management
- Better for static, version-controlled configurations
- Can be combined with Data Plane API for hybrid approach

### Service Mesh Solutions
- Istio, Linkerd for Kubernetes environments
- More comprehensive but higher complexity
- Built-in service discovery and traffic management

## Resources

- **Official Documentation**: https://www.haproxy.com/documentation/haproxy-data-plane-api/
- **GitHub Repository**: https://github.com/haproxytech/dataplaneapi
- **API Specification**: https://github.com/haproxytech/dataplaneapi-specification
- **HAProxy Community Forum**: https://discourse.haproxy.org/
- **Blog Posts**: 
  - https://www.haproxy.com/blog/new-haproxy-data-plane-api
  - https://www.haproxy.com/blog/announcing-haproxy-data-plane-api-2-1

## Conclusion

The HAProxy Data Plane API provides a powerful, RESTful interface for dynamic HAProxy configuration management. It's particularly valuable for:

- Cloud-native environments requiring dynamic configuration
- CI/CD pipelines implementing blue-green or canary deployments
- Auto-scaling scenarios based on load or health metrics
- Multi-tenant environments requiring isolated configuration changes

While it requires careful version management and error handling, the API's transaction support and comprehensive endpoint coverage make it an excellent choice for programmatic HAProxy management in modern infrastructure.