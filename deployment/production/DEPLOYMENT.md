# Mini Infra Deployment Guide

## Quick Start with Docker Compose

This guide will help you deploy Mini Infra on a Linux server using Docker Compose.

### Prerequisites

- Linux server with Docker and Docker Compose installed
- Access to Docker daemon (`/var/run/docker.sock`)
- Port 5000 available (or configure a different port)
- (Optional) Domain name for production deployment

### Step 1: Clone or Copy Files

On your Linux server, you'll need:
- `docker-compose.yaml`
- `.env` (create from `.env.example`)

```bash
# Clone the repository (or copy the files manually)
git clone <repository-url>
cd mini-infra
```

### Step 2: Configure Environment Variables

Copy the example environment file and edit it with your values:

```bash
cp .env.example .env
nano .env  # or use your preferred editor
```

**Configuration:**

1. The application auto-generates an `APP_SECRET` on first boot. To provide your own, add it to `.env`:
   ```bash
   APP_SECRET=<openssl rand -base64 32>
   ```

2. **(Optional) Configure Google OAuth** for authentication:
   - Google OAuth can be enabled and configured through the Authentication Settings page in the UI after initial setup
   - Create OAuth credentials at https://console.cloud.google.com/
   - Add authorized redirect URI: `http://your-server:5000/auth/google/callback`

4. **(Optional) Configure OpenObserve** integration for log forwarding:
   ```bash
   OPENOBSERVE_ORGANIZATION_NAME=default
   OPENOBSERVE_USERNAME=your-username
   OPENOBSERVE_PASSWORD=your-password
   ```

### Step 3: Deploy with Docker Compose

```bash
# Pull the latest images
docker compose pull

# Start the services
docker compose up -d

# Check service status
docker compose ps

# View logs
docker compose logs -f mini-infra
```

### Step 4: Verify Deployment

1. **Check health status:**
   ```bash
   curl http://localhost:5000/health
   ```

2. **Access the application:**
   - Open browser: `http://your-server:5000`
   - You should see the Mini Infra login page

3. **Monitor logs:**
   ```bash
   # Application logs
   docker compose logs -f mini-infra

   # All services
   docker compose logs -f
   ```

### Step 5: Post-Deployment Configuration

Once logged in to Mini Infra, configure:

1. **Docker Host Settings** (System Settings → System)
   - Configure connection to Docker daemon
   - The default socket is already mounted via docker-compose

2. **Azure Blob Storage** (if using PostgreSQL backups)
   - Add Azure Storage connection strings
   - Configure backup schedules

3. **Cloudflare** (if monitoring tunnels)
   - Add Cloudflare API credentials
   - Configure tunnel monitoring

## Production Deployment Considerations

### Security

**Docker Socket Access:**
- The container has full access to Docker daemon via socket mount
- Only deploy in trusted environments
- Consider network isolation or firewall rules
- The container runs as non-root user (`node`) for security

**Environment Variables:**
- NEVER commit `.env` to version control
- Ensure `APP_SECRET` is generated (auto-generated on first boot, or set manually)
- Rotate secrets regularly
- Consider using Docker secrets for sensitive data

### Reverse Proxy Setup

For production, use a reverse proxy (nginx, Caddy, Traefik) with HTTPS:

**Example nginx configuration:**
```nginx
server {
    listen 443 ssl http2;
    server_name mini-infra.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Update `.env` for HTTPS:
```bash
PUBLIC_URL=https://mini-infra.yourdomain.com
GOOGLE_CALLBACK_URL=https://mini-infra.yourdomain.com/auth/google/callback
```

### Data Persistence

The docker-compose configuration creates named volumes:
- `mini-infra-data`: SQLite database and application data
- `mini-infra-logs`: Application log files
- `openobserve_data`: OpenObserve data

**Backup these volumes regularly:**
```bash
# Backup database
docker compose exec mini-infra tar czf - /app/data | gzip > mini-infra-backup-$(date +%Y%m%d).tar.gz

# List volumes
docker volume ls

# Inspect volume location
docker volume inspect mini-infra_mini-infra-data
```

### Monitoring

**Health Checks:**
The container includes automatic health checks:
```bash
# View health status
docker compose ps

# Check health manually
docker compose exec mini-infra node -e "require('http').get('http://localhost:5000/health', (r) => {r.on('data', d => console.log(d.toString()))})"
```

**Log Forwarding:**
- Configure OpenObserve integration in `.env`
- Enable OpenTelemetry for distributed tracing
- Logs are also available in `mini-infra-logs` volume

## Managing the Deployment

### Common Commands

```bash
# Start services
docker compose up -d

# Stop services
docker compose down

# Restart services
docker compose restart

# View logs
docker compose logs -f

# Update to latest version
docker compose pull
docker compose up -d

# Check resource usage
docker stats mini-infra

# Execute commands in container
docker compose exec mini-infra sh

# Access database
docker compose exec mini-infra sh -c "cd /app/data && ls -la"
```

### Updating the Application

```bash
# Pull latest image
docker compose pull mini-infra

# Recreate container with new image
docker compose up -d --force-recreate mini-infra

# Database migrations run automatically on startup
```

### Troubleshooting

**Container won't start:**
```bash
# Check logs
docker compose logs mini-infra

# Common issues:
# - APP_SECRET not generated (should auto-generate on first boot)
# - Port 5000 already in use
# - Docker socket permissions
```

**Database issues:**
```bash
# Check database file
docker compose exec mini-infra ls -la /app/data

# View migration status
docker compose exec mini-infra npx prisma migrate status
```

**Docker socket permission denied:**
```bash
# On host, check Docker socket permissions
ls -la /var/run/docker.sock

# Add user to docker group if needed
sudo usermod -aG docker $USER
```

**Health check failing:**
```bash
# Check if app is responding
docker compose exec mini-infra wget -O- http://localhost:5000/health

# Check port binding
docker compose ps
netstat -tlnp | grep 5000
```

## Environment Variables Reference

See `.env.example` for a complete list of available configuration options.

### Optional Variables
- `APP_SECRET` - Application secret for auth and encryption (auto-generated on first boot if not set)
- `ALLOWED_ADMIN_EMAILS` - Comma-separated list of allowed login emails
- `MINI_INFRA_PORT` - Port to expose (default: 5000)
- `PUBLIC_URL` - Public URL for the application
- `LOG_LEVEL` - Logging verbosity (trace|debug|info|warn|error|fatal)
- `OPENOBSERVE_*` - OpenObserve log forwarding configuration
- `OTEL_*` - OpenTelemetry tracing configuration

## Docker Image Information

- **Registry:** GitHub Container Registry (ghcr.io)
- **Image:** `ghcr.io/mrgeoffrich/mini-infra:latest`
- **Base:** Node.js 24 Alpine Linux
- **Size:** ~300-400MB
- **Security:** Runs as non-root user (`node`)
- **Updates:** Automatically built on every push to main branch

### Available Tags
- `latest` - Latest build from main branch
- `main-<sha>` - Specific commit from main branch
- Custom version tags if releases are tagged

## Support

For issues and questions:
- GitHub Issues: <repository-issues-url>
- Documentation: See CLAUDE.md for development details
