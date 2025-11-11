# HAProxy Concepts and DataPlane API Guide

## Configuration Version Management

### How Version Numbers Work

HAProxy's DataPlane API uses a **configuration version number** to ensure consistency and prevent conflicts when multiple clients attempt to modify the configuration simultaneously.

#### Key Principles:

1. **Monotonic Incrementing**: Each configuration change increments the version number by 1
2. **Optimistic Locking**: Clients must specify the current version when making changes
3. **Conflict Prevention**: If the specified version doesn't match the current version, the operation fails
4. **Atomic Operations**: Version changes only occur when the entire operation succeeds

#### Example Workflow:

```bash
# Get current version
curl "http://localhost:5555/v3/services/haproxy/configuration/version"
# Returns: 5

# Create a backend with version parameter
curl -X POST "http://localhost:5555/v3/services/haproxy/configuration/backends?version=5" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-backend", "mode": "http"}'
# Success: Version becomes 6

# Another client tries to use the old version
curl -X POST "http://localhost:5555/v3/services/haproxy/configuration/backends?version=5" \
  -H "Content-Type: application/json" \
  -d '{"name": "another-backend", "mode": "http"}'
# Fails: Version conflict (expected 6, got 5)
```

#### Version Behavior:
- **Read Operations**: Don't require version parameters and don't change the version
- **Write Operations**: Always require `?version=X` parameter and increment version on success
- **Failed Operations**: Don't change the version number
- **Reloads**: Triggered automatically after successful configuration changes

---

## HAProxy Architecture Components

HAProxy operates on a simple but powerful model with three main components that work together to provide load balancing and reverse proxy functionality.

### Frontend

A **frontend** is the entry point where HAProxy listens for incoming client connections.

#### Purpose:
- Defines where HAProxy listens (IP address and port)
- Specifies the protocol (HTTP, HTTPS, TCP)
- Contains rules for routing traffic to backends
- Handles SSL/TLS termination
- Applies request filtering and modification

#### Configuration Example:
```
frontend web-frontend
    bind *:80                    # Listen on all interfaces, port 80
    bind *:443 ssl crt /path/to/cert.pem  # HTTPS with SSL certificate
    mode http                    # HTTP mode
    default_backend web-servers  # Route traffic to backend named "web-servers"

    # Optional: conditional routing
    acl is_api path_beg /api/
    use_backend api-servers if is_api
```

#### Key Frontend Concepts:
- **Bind Directive**: Specifies listening address and port
- **Mode**: Protocol type (http, tcp, health)
- **ACLs**: Access Control Lists for conditional routing
- **Default Backend**: Where traffic goes if no specific rules match

### Backend

A **backend** is a pool of servers that can handle requests forwarded from frontends.

#### Purpose:
- Groups multiple servers together
- Defines load balancing algorithm
- Configures health checks
- Sets connection timeouts and limits
- Handles server failure scenarios

#### Configuration Example:
```
backend web-servers
    mode http
    balance roundrobin           # Load balancing algorithm
    option httpchk GET /health   # Health check configuration

    # Server definitions (see Server section below)
    server web1 192.168.1.10:8080 check
    server web2 192.168.1.11:8080 check
    server web3 192.168.1.12:8080 check backup  # Backup server
```

#### Load Balancing Algorithms:
- **roundrobin**: Requests distributed evenly in rotation
- **leastconn**: Route to server with fewest active connections
- **source**: Route based on client IP (session persistence)
- **uri**: Route based on request URI
- **random**: Random server selection

#### Backend States:
- **Active**: Normal operation with healthy servers
- **Backup**: Fallback servers used when all active servers fail
- **Maintenance**: Temporarily removed from load balancing

### Server

A **server** represents an individual application instance within a backend.

#### Purpose:
- Defines the actual endpoint (IP and port) for application traffic
- Configures health check parameters
- Sets individual server weights and limits
- Manages server state (up, down, maintenance)

#### Configuration Example:
```
server web1 192.168.1.10:8080 check inter 5000 rise 2 fall 3 weight 100
```

#### Server Parameters Explained:
- **`192.168.1.10:8080`**: Server address and port
- **`check`**: Enable health checks
- **`inter 5000`**: Health check interval (5 seconds)
- **`rise 2`**: Number of successful checks to mark server as UP
- **`fall 3`**: Number of failed checks to mark server as DOWN
- **`weight 100`**: Relative weight for load balancing (higher = more traffic)

#### Server States:
- **UP**: Server is healthy and receiving traffic
- **DOWN**: Server failed health checks, no traffic sent
- **MAINT**: Server in maintenance mode (manually disabled)
- **DRAIN**: Server gracefully shutting down, no new connections
- **NOLB**: Server up but not participating in load balancing

---

## Complete Traffic Flow Example

```
Client Request → Frontend → Backend → Server
```

### Example Configuration:
```
# Frontend: Entry point
frontend api-gateway
    bind *:80
    mode http

    # Route /api/ requests to API backend
    acl is_api path_beg /api/
    use_backend api-servers if is_api

    # Route everything else to web backend
    default_backend web-servers

# Backend: API servers
backend api-servers
    mode http
    balance leastconn
    option httpchk GET /health

    server api1 10.0.1.10:3000 check weight 100
    server api2 10.0.1.11:3000 check weight 100
    server api3 10.0.1.12:3000 check weight 50 backup

# Backend: Web servers
backend web-servers
    mode http
    balance roundrobin
    option httpchk GET /

    server web1 10.0.2.10:8080 check
    server web2 10.0.2.11:8080 check
    server web3 10.0.2.12:8080 check
```

### Traffic Flow:
1. **Client** sends request to `http://example.com/api/users`
2. **Frontend** `api-gateway` receives the request on port 80
3. **ACL** `is_api` matches the `/api/` path
4. **Backend** `api-servers` is selected via the `use_backend` rule
5. **Load Balancer** chooses `api2` using `leastconn` algorithm
6. **Server** `api2` processes the request and returns response
7. **Response** flows back through backend → frontend → client

---

## DataPlane API Operations

### Common Operations with Version Management:

#### 1. Create Backend:
```bash
# Get current version first
VERSION=$(curl -s "http://localhost:5555/v3/services/haproxy/configuration/version" \
  -H "Authorization: Basic $(echo -n 'admin:adminpwd' | base64)")

# Create backend
curl -X POST "http://localhost:5555/v3/services/haproxy/configuration/backends?version=$VERSION" \
  -H "Authorization: Basic $(echo -n 'admin:adminpwd' | base64)" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-app-backend",
    "mode": "http",
    "balance": {"algorithm": "roundrobin"}
  }'
```

#### 2. Add Server to Backend:
```bash
# Get new version after backend creation
VERSION=$(curl -s "http://localhost:5555/v3/services/haproxy/configuration/version" \
  -H "Authorization: Basic $(echo -n 'admin:adminpwd' | base64)")

# Add server (endpoint varies by HAProxy version)
curl -X POST "http://localhost:5555/v3/services/haproxy/configuration/servers?backend=my-app-backend&version=$VERSION" \
  -H "Authorization: Basic $(echo -n 'admin:adminpwd' | base64)" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "app-server-1",
    "address": "10.0.1.100",
    "port": 8080,
    "check": "enabled"
  }'
```

#### 3. Create Frontend:
```bash
VERSION=$(curl -s "http://localhost:5555/v3/services/haproxy/configuration/version" \
  -H "Authorization: Basic $(echo -n 'admin:adminpwd' | base64)")

curl -X POST "http://localhost:5555/v3/services/haproxy/configuration/frontends?version=$VERSION" \
  -H "Authorization: Basic $(echo -n 'admin:adminpwd' | base64)" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-app-frontend",
    "mode": "http",
    "default_backend": "my-app-backend"
  }'
```

---

## Best Practices

### Version Management:
1. **Always check version** before making changes
2. **Handle version conflicts** gracefully with retry logic
3. **Use transactions** for multiple related changes
4. **Monitor reload triggers** to understand configuration change impact

### Architecture Design:
1. **Separate concerns**: Different frontends for different protocols/ports
2. **Group related servers**: Backends should contain servers serving the same application/service
3. **Plan for failure**: Always configure health checks and backup servers
4. **Monitor performance**: Use HAProxy stats to understand traffic patterns

### Health Checks:
1. **Use meaningful endpoints**: Health check URLs should verify actual application readiness
2. **Tune timing parameters**: Balance between quick failure detection and avoiding false positives
3. **Consider application startup time**: Set appropriate `rise` values for slow-starting applications

---

## Troubleshooting

### Common Issues:

#### Version Conflicts:
```bash
# Error: {"code":409,"message":"Version conflict"}
# Solution: Get latest version and retry
```

#### Server Not Receiving Traffic:
1. Check server state: `UP`, `DOWN`, `MAINT`
2. Verify health check endpoint responds correctly
3. Confirm backend load balancing algorithm
4. Review server weight settings

#### Configuration Not Applied:
1. Verify reload occurred (check HAProxy logs)
2. Confirm transaction was committed
3. Check for configuration syntax errors
4. Validate version incremented after change

### Monitoring Commands:
```bash
# Check server states
curl "http://localhost:5555/v3/services/haproxy/stats/native" \
  -H "Authorization: Basic $(echo -n 'admin:adminpwd' | base64)"

# View configuration
curl "http://localhost:5555/v3/services/haproxy/configuration/raw" \
  -H "Authorization: Basic $(echo -n 'admin:adminpwd' | base64)"

# Monitor reloads
docker logs haproxy-container-name | grep -E "(reload|USR2|Loading)"
```