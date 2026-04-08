# Mini Infra

A web application for managing a single Docker host and its associated infrastructure. Provides centralized management for Docker containers, PostgreSQL database backups, zero-downtime deployments using HAProxy, and Cloudflare tunnel monitoring.

## Screenshots

_Coming soon._

## Prerequisites

- [Node.js](https://nodejs.org/) 24+ (npm is included)
- [Docker](https://www.docker.com/) (for container management features)
- [Google OAuth credentials](https://console.cloud.google.com/apis/credentials) (for authentication)

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/mrgeoffrich/mini-infra.git
cd mini-infra
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy the example environment file:

**macOS / Linux:**
```bash
cp server/.env.example server/.env
```

**Windows (PowerShell):**
```powershell
Copy-Item server\.env.example server\.env
```

### 4. Generate secrets

You need to provide values for `SESSION_SECRET`, `API_KEY_SECRET`, and `ENCRYPTION_SECRET` in `server/.env`.

**macOS / Linux:**
```bash
openssl rand -base64 32
```

**Windows (PowerShell):**
```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }) -as [byte[]])
```

Run the command three times and paste each value into the corresponding variable in `server/.env`.

### 5. Set required variables

Open `server/.env` and fill in the following:

| Variable | Description |
|---|---|
| `SESSION_SECRET` | Random secret for session signing |
| `API_KEY_SECRET` | Random secret for API key hashing |
| `ENCRYPTION_SECRET` | Random secret for credential encryption |
| `ALLOWED_ADMIN_EMAILS` | (Optional) Comma-separated list of email addresses allowed to log in |

### 6. Start the development server

```bash
npm run dev
```

This starts three services concurrently: the shared types library (watch mode), the Express backend, and the Vite frontend. The app will be available at [http://localhost:3000](http://localhost:3000) with the API on port 5005.

## Environment Variables

See [`server/.env.example`](server/.env.example) for the full list of environment variables. Key optional variables include:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `5005` | Backend server port |
| `PUBLIC_URL` | `http://localhost:3000` | Public-facing URL (used for CORS and OAuth callbacks) |
| `LOG_LEVEL` | `debug` | Logging level (`debug`, `info`, `warn`, `error`) |
| `ALLOW_INSECURE` | `false` | Disable HTTPS-enforcing headers (auto-set when `PUBLIC_URL` uses `http://`) |

## Running with Docker

Pre-built Docker images and deployment configurations are available in the [`deployment/`](deployment/) directory. See:

- [`deployment/README.md`](deployment/README.md) for an overview
- [`deployment/development/README.md`](deployment/development/README.md) for local Docker development
- [`deployment/production/DEPLOYMENT.md`](deployment/production/DEPLOYMENT.md) for production deployment

## Agent Tracing

If the AI assistant is enabled (API key configured via Settings UI), you can trace agent interactions using the Claude Agent SDK's built-in beta tracing. Set these environment variables on the Mini Infra server — they are automatically forwarded to the agent sidecar container:

| Variable | Description |
|---|---|
| `ENABLE_BETA_TRACING_DETAILED` | Set to `1` to enable detailed beta tracing |
| `BETA_TRACING_ENDPOINT` | URL of the tracing backend to receive trace data |

For the dev Docker deployment, add these to your `deployment/development/.env` file and restart (or run `./start.sh --just-copy-env` to refresh env vars without rebuilding).

## Running Tests

```bash
npm test -w server
```

To run a single test file:

```bash
npx -w server vitest run src/__tests__/your-test-file.test.ts
```

## Tech Stack

- **Frontend:** React 19, Vite, Tailwind CSS, shadcn/ui, TanStack Query
- **Backend:** Express.js 5, Prisma ORM, SQLite
- **Auth:** Google OAuth 2.0 via Passport
- **Infrastructure:** Docker API (dockerode), HAProxy, Cloudflare API, Azure Blob Storage
- **Language:** TypeScript throughout (shared types via npm workspaces)

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
