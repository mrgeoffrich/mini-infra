# DNS and Frontend Routing API Documentation

## Overview

This document describes the REST API endpoints for managing DNS records and HAProxy frontend configurations for deployments. These APIs enable automatic DNS record creation and HAProxy frontend configuration for hostname-based routing.

## Base URL

```
http://localhost:5000/api
```

## Authentication

All endpoints require authentication using either:
- **Session Cookie**: For browser-based requests
- **API Key Header**: For programmatic access

```bash
# Using API key
curl -H "x-api-key: your-api-key" http://localhost:5000/api/...

# OR
curl -H "Authorization: Bearer your-api-key" http://localhost:5000/api/...
```

To get your development API key:
```bash
cd server && npm run show-dev-key
```

---

## DNS Management Endpoints

### Get DNS Records for Deployment

Get all DNS records associated with a deployment configuration.

**Endpoint:** `GET /api/deployments/configs/:configId/dns`

**Parameters:**
- `configId` (path, required) - Deployment configuration ID

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "dns_record_123",
      "deploymentConfigId": "config_456",
      "hostname": "api.example.com",
      "dnsProvider": "cloudflare",
      "dnsRecordId": "cf_record_789",
      "ipAddress": "192.168.1.100",
      "zoneId": "zone_abc",
      "zoneName": "example.com",
      "status": "active",
      "createdAt": "2025-01-15T10:30:00Z",
      "updatedAt": "2025-01-15T10:30:00Z",
      "errorMessage": null
    }
  ]
}
```

**Status Codes:**
- `200` - Success
- `401` - Unauthorized
- `404` - Deployment configuration not found
- `500` - Server error

**Example:**

```bash
curl -H "x-api-key: dev_key_123" \
  http://localhost:5000/api/deployments/configs/config_456/dns
```

---

### Sync DNS Record

Manually synchronize a DNS record (recreate if missing, update if changed).

**Endpoint:** `POST /api/deployments/configs/:configId/dns/sync`

**Parameters:**
- `configId` (path, required) - Deployment configuration ID

**Request Body:** None

**Response:**

```json
{
  "success": true,
  "message": "DNS record synchronized successfully",
  "data": {
    "id": "dns_record_123",
    "hostname": "api.example.com",
    "ipAddress": "192.168.1.100",
    "status": "active",
    "updatedAt": "2025-01-15T11:00:00Z"
  }
}
```

**Status Codes:**
- `200` - Success
- `400` - Invalid request (e.g., network type doesn't require DNS)
- `401` - Unauthorized
- `404` - Deployment configuration not found
- `500` - Server error

**Example:**

```bash
curl -X POST \
  -H "x-api-key: dev_key_123" \
  http://localhost:5000/api/deployments/configs/config_456/dns/sync
```

---

### Delete DNS Record

Manually delete a DNS record for a deployment.

**Endpoint:** `DELETE /api/deployments/configs/:configId/dns`

**Parameters:**
- `configId` (path, required) - Deployment configuration ID

**Response:**

```json
{
  "success": true,
  "message": "DNS record deleted successfully"
}
```

**Status Codes:**
- `200` - Success
- `401` - Unauthorized
- `404` - Deployment configuration or DNS record not found
- `500` - Server error

**Example:**

```bash
curl -X DELETE \
  -H "x-api-key: dev_key_123" \
  http://localhost:5000/api/deployments/configs/config_456/dns
```

---

### List All DNS Records

Get all DNS records across all deployments.

**Endpoint:** `GET /api/deployments/dns`

**Query Parameters:**
- `status` (optional) - Filter by status: `active`, `pending`, `failed`, `removed`
- `dnsProvider` (optional) - Filter by provider: `cloudflare`, `external`
- `hostname` (optional) - Filter by hostname (partial match)

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "dns_record_123",
      "deploymentConfigId": "config_456",
      "hostname": "api.example.com",
      "dnsProvider": "cloudflare",
      "status": "active",
      "ipAddress": "192.168.1.100",
      "createdAt": "2025-01-15T10:30:00Z",
      "updatedAt": "2025-01-15T10:30:00Z"
    },
    {
      "id": "dns_record_124",
      "deploymentConfigId": "config_457",
      "hostname": "web.example.com",
      "dnsProvider": "cloudflare",
      "status": "active",
      "ipAddress": "192.168.1.100",
      "createdAt": "2025-01-15T09:00:00Z",
      "updatedAt": "2025-01-15T09:00:00Z"
    }
  ]
}
```

**Status Codes:**
- `200` - Success
- `401` - Unauthorized
- `500` - Server error

**Example:**

```bash
# Get all active DNS records
curl -H "x-api-key: dev_key_123" \
  "http://localhost:5000/api/deployments/dns?status=active"

# Get DNS records for specific hostname
curl -H "x-api-key: dev_key_123" \
  "http://localhost:5000/api/deployments/dns?hostname=api.example.com"
```

---

## HAProxy Frontend Management Endpoints

### Get Frontend for Deployment

Get the HAProxy frontend configuration for a deployment.

**Endpoint:** `GET /api/deployments/configs/:configId/frontend`

**Parameters:**
- `configId` (path, required) - Deployment configuration ID

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "frontend_123",
    "deploymentConfigId": "config_456",
    "frontendName": "fe_myapp_env789",
    "backendName": "be_myapp_env789",
    "hostname": "api.example.com",
    "bindPort": 80,
    "bindAddress": "*",
    "useSSL": false,
    "status": "active",
    "createdAt": "2025-01-15T10:30:00Z",
    "updatedAt": "2025-01-15T10:30:00Z",
    "errorMessage": null
  }
}
```

**Status Codes:**
- `200` - Success
- `401` - Unauthorized
- `404` - Deployment configuration or frontend not found
- `500` - Server error

**Example:**

```bash
curl -H "x-api-key: dev_key_123" \
  http://localhost:5000/api/deployments/configs/config_456/frontend
```

---

### Sync Frontend Configuration

Manually synchronize HAProxy frontend configuration.

**Endpoint:** `POST /api/deployments/configs/:configId/frontend/sync`

**Parameters:**
- `configId` (path, required) - Deployment configuration ID

**Request Body:** None

**Response:**

```json
{
  "success": true,
  "message": "Frontend configuration synchronized successfully",
  "data": {
    "frontendName": "fe_myapp_env789",
    "backendName": "be_myapp_env789",
    "hostname": "api.example.com",
    "status": "active",
    "updatedAt": "2025-01-15T11:00:00Z"
  }
}
```

**Status Codes:**
- `200` - Success
- `400` - Invalid request
- `401` - Unauthorized
- `404` - Deployment configuration not found
- `500` - Server error

**Example:**

```bash
curl -X POST \
  -H "x-api-key: dev_key_123" \
  http://localhost:5000/api/deployments/configs/config_456/frontend/sync
```

---

### List All Frontends

Get all HAProxy frontends managed by the system.

**Endpoint:** `GET /api/haproxy/frontends`

**Query Parameters:**
- `status` (optional) - Filter by status: `active`, `pending`, `failed`, `removed`
- `hostname` (optional) - Filter by hostname (partial match)

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "frontend_123",
      "deploymentConfigId": "config_456",
      "frontendName": "fe_myapp_env789",
      "backendName": "be_myapp_env789",
      "hostname": "api.example.com",
      "bindPort": 80,
      "bindAddress": "*",
      "status": "active",
      "createdAt": "2025-01-15T10:30:00Z",
      "updatedAt": "2025-01-15T10:30:00Z"
    },
    {
      "id": "frontend_124",
      "deploymentConfigId": "config_457",
      "frontendName": "fe_webapp_env790",
      "backendName": "be_webapp_env790",
      "hostname": "web.example.com",
      "bindPort": 80,
      "bindAddress": "*",
      "status": "active",
      "createdAt": "2025-01-15T09:00:00Z",
      "updatedAt": "2025-01-15T09:00:00Z"
    }
  ]
}
```

**Status Codes:**
- `200` - Success
- `401` - Unauthorized
- `500` - Server error

**Example:**

```bash
# Get all active frontends
curl -H "x-api-key: dev_key_123" \
  "http://localhost:5000/api/haproxy/frontends?status=active"

# Get frontends for specific hostname
curl -H "x-api-key: dev_key_123" \
  "http://localhost:5000/api/haproxy/frontends?hostname=api.example.com"
```

---

### Get Frontend Details

Get detailed information about a specific HAProxy frontend.

**Endpoint:** `GET /api/haproxy/frontends/:frontendName`

**Parameters:**
- `frontendName` (path, required) - Frontend name (e.g., `fe_myapp_env789`)

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "frontend_123",
    "deploymentConfigId": "config_456",
    "frontendName": "fe_myapp_env789",
    "backendName": "be_myapp_env789",
    "hostname": "api.example.com",
    "bindPort": 80,
    "bindAddress": "*",
    "useSSL": false,
    "status": "active",
    "createdAt": "2025-01-15T10:30:00Z",
    "updatedAt": "2025-01-15T10:30:00Z",
    "haproxyConfig": {
      "mode": "http",
      "default_backend": "be_myapp_env789",
      "binds": [
        {
          "address": "*",
          "port": 80
        }
      ],
      "acls": [
        {
          "name": "acl_api_example_com",
          "criterion": "hdr(host)",
          "value": "api.example.com"
        }
      ],
      "rules": [
        {
          "type": "use_backend",
          "backend": "be_myapp_env789",
          "condition": "if acl_api_example_com"
        }
      ]
    }
  }
}
```

**Status Codes:**
- `200` - Success
- `401` - Unauthorized
- `404` - Frontend not found
- `500` - Server error

**Example:**

```bash
curl -H "x-api-key: dev_key_123" \
  http://localhost:5000/api/haproxy/frontends/fe_myapp_env789
```

---

## Extended Deployment Endpoints

### Get Deployment Configuration (Extended)

The existing deployment configuration endpoint has been extended to include DNS and frontend information.

**Endpoint:** `GET /api/deployments/configs/:id`

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "config_456",
    "applicationName": "myapp",
    "hostname": "api.example.com",
    "image": "myapp:latest",
    "containerPort": 3000,
    "environmentId": "env_789",
    "environment": {
      "id": "env_789",
      "name": "production",
      "networkType": "local"
    },
    "dnsRecords": [
      {
        "id": "dns_record_123",
        "hostname": "api.example.com",
        "dnsProvider": "cloudflare",
        "ipAddress": "192.168.1.100",
        "status": "active"
      }
    ],
    "haproxyFrontend": {
      "id": "frontend_123",
      "frontendName": "fe_myapp_env789",
      "backendName": "be_myapp_env789",
      "hostname": "api.example.com",
      "status": "active"
    },
    "createdAt": "2025-01-15T10:00:00Z",
    "updatedAt": "2025-01-15T10:30:00Z"
  }
}
```

---

## Data Models

### DeploymentDNSRecord

```typescript
{
  id: string;                    // Unique identifier
  deploymentConfigId: string;    // Reference to deployment configuration
  hostname: string;              // DNS hostname (e.g., api.example.com)
  dnsProvider: 'cloudflare' | 'external';  // DNS provider
  dnsRecordId?: string;          // Provider's record ID
  ipAddress?: string;            // IP address in DNS record
  zoneId?: string;               // CloudFlare zone ID
  zoneName?: string;             // CloudFlare zone name
  status: 'active' | 'pending' | 'failed' | 'removed';
  errorMessage?: string;         // Error message if status is 'failed'
  createdAt: Date;               // Creation timestamp
  updatedAt: Date;               // Last update timestamp
}
```

### HAProxyFrontend

```typescript
{
  id: string;                    // Unique identifier
  deploymentConfigId: string;    // Reference to deployment configuration
  frontendName: string;          // HAProxy frontend name (unique)
  backendName: string;           // HAProxy backend name
  hostname: string;              // Hostname for routing
  bindPort: number;              // Bind port (typically 80 or 443)
  bindAddress: string;           // Bind address (typically "*")
  useSSL: boolean;               // SSL/TLS enabled
  status: 'active' | 'pending' | 'failed' | 'removed';
  errorMessage?: string;         // Error message if status is 'failed'
  createdAt: Date;               // Creation timestamp
  updatedAt: Date;               // Last update timestamp
}
```

---

## Error Responses

All endpoints follow a consistent error response format:

```json
{
  "success": false,
  "error": "Error message",
  "details": {
    // Additional error details (optional)
  }
}
```

### Common Error Codes

| Status Code | Description |
|------------|-------------|
| 400 | Bad Request - Invalid input parameters |
| 401 | Unauthorized - Missing or invalid authentication |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource doesn't exist |
| 409 | Conflict - Resource already exists or state conflict |
| 500 | Internal Server Error - Server-side error |
| 503 | Service Unavailable - External service (HAProxy, CloudFlare) unavailable |

---

## Rate Limiting

API endpoints are subject to rate limiting to prevent abuse:

- **Authenticated requests**: 1000 requests per hour per user
- **DNS sync operations**: 10 requests per minute per deployment
- **Frontend sync operations**: 10 requests per minute per deployment

Rate limit headers are included in responses:

```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1642345678
```

---

## Webhooks (Future Enhancement)

Future versions may support webhooks for DNS and frontend events:

- `dns.record.created` - DNS record successfully created
- `dns.record.failed` - DNS record creation failed
- `dns.record.deleted` - DNS record deleted
- `frontend.created` - Frontend successfully created
- `frontend.failed` - Frontend creation failed
- `frontend.deleted` - Frontend deleted

---

## Code Examples

### Python

```python
import requests

API_KEY = "your-api-key"
BASE_URL = "http://localhost:5000/api"

headers = {
    "x-api-key": API_KEY
}

# Get DNS records for a deployment
response = requests.get(
    f"{BASE_URL}/deployments/configs/config_456/dns",
    headers=headers
)

if response.status_code == 200:
    data = response.json()
    print(f"DNS Records: {data['data']}")
else:
    print(f"Error: {response.status_code} - {response.text}")

# Sync DNS record
response = requests.post(
    f"{BASE_URL}/deployments/configs/config_456/dns/sync",
    headers=headers
)

if response.status_code == 200:
    print("DNS synchronized successfully")
```

### JavaScript/Node.js

```javascript
const axios = require('axios');

const API_KEY = 'your-api-key';
const BASE_URL = 'http://localhost:5000/api';

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    'x-api-key': API_KEY
  }
});

// Get DNS records for a deployment
async function getDNSRecords(configId) {
  try {
    const response = await client.get(`/deployments/configs/${configId}/dns`);
    console.log('DNS Records:', response.data.data);
    return response.data.data;
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

// Sync DNS record
async function syncDNS(configId) {
  try {
    const response = await client.post(`/deployments/configs/${configId}/dns/sync`);
    console.log('DNS synchronized:', response.data.message);
    return response.data;
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

// Get frontend configuration
async function getFrontend(configId) {
  try {
    const response = await client.get(`/deployments/configs/${configId}/frontend`);
    console.log('Frontend:', response.data.data);
    return response.data.data;
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

// Usage
getDNSRecords('config_456');
syncDNS('config_456');
getFrontend('config_456');
```

### cURL

```bash
#!/bin/bash

API_KEY="your-api-key"
BASE_URL="http://localhost:5000/api"
CONFIG_ID="config_456"

# Get DNS records
echo "Getting DNS records..."
curl -H "x-api-key: $API_KEY" \
  "$BASE_URL/deployments/configs/$CONFIG_ID/dns"

# Sync DNS
echo -e "\n\nSyncing DNS..."
curl -X POST \
  -H "x-api-key: $API_KEY" \
  "$BASE_URL/deployments/configs/$CONFIG_ID/dns/sync"

# Get frontend
echo -e "\n\nGetting frontend..."
curl -H "x-api-key: $API_KEY" \
  "$BASE_URL/deployments/configs/$CONFIG_ID/frontend"

# List all DNS records with filters
echo -e "\n\nListing active DNS records..."
curl -H "x-api-key: $API_KEY" \
  "$BASE_URL/deployments/dns?status=active"

# List all frontends
echo -e "\n\nListing all frontends..."
curl -H "x-api-key: $API_KEY" \
  "$BASE_URL/haproxy/frontends"
```

---

## Additional Resources

- [HAProxy DataPlane API Documentation](https://www.haproxy.com/documentation/dataplaneapi/latest/)
- [CloudFlare API Documentation](https://developers.cloudflare.com/api/)
- [End-to-End Testing Guide](./DNS-FRONTEND-E2E-TESTING.md)
- [Troubleshooting Guide](./DNS-FRONTEND-TROUBLESHOOTING.md)

---

## Changelog

### Version 1.0.0 (2025-01-15)

- Initial release of DNS and Frontend Routing APIs
- DNS record management endpoints
- HAProxy frontend management endpoints
- Extended deployment configuration endpoint
- Support for CloudFlare DNS provider
- Support for local and internet network types
