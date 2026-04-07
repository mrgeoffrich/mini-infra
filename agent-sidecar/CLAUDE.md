# Agent Sidecar

AI operations assistant that runs as a separate container alongside Mini Infra. Provides a natural language interface to Docker, the Mini Infra API, and documentation via per-user conversations with SSE streaming.

## Project Structure

```
agent-sidecar/
├── src/
│   ├── index.ts                 # Express server setup, startup, signal handling
│   ├── logger.ts                # Pino logging configuration
│   ├── types.ts                 # Turn state, SSE events, API request/response types
│   ├── turn-store.ts            # In-memory turn store with state machine
│   ├── async-message-queue.ts   # AsyncIterable queue for streaming prompts to SDK
│   ├── middleware/
│   │   └── auth.ts              # Bearer token auth (timing-safe, optional in dev)
│   ├── routes/
│   │   ├── turns.ts             # Turn CRUD + SSE streaming endpoints
│   │   └── health.ts            # Health check endpoint
│   └── agent/
│       ├── runner.ts            # Main agent loop (tappedQuery, stream processing)
│       ├── system-prompt.ts     # Dynamic system prompt builder
│       ├── tools.ts             # Bash safety validation
│       ├── file-sink.ts         # NDJSON file sink for SDK message logging
│       ├── infra-tools-mcp.ts   # MCP server: api_request, list_docs, read_doc
│       └── ui-tools-mcp.ts      # MCP server: highlight_element, navigate_to
├── Dockerfile                   # Multi-stage production build
├── vitest.config.ts             # Test configuration
└── package.json
```

## Important: Not in npm Workspaces

This package is **not** part of the root npm workspace. You must `cd agent-sidecar` to run npm commands, then `cd` back to the project root afterwards.

## Commands

```bash
cd agent-sidecar
npm run dev          # Watch mode with tsx
npm run build        # Compile TypeScript
npm start            # Start production server (dist/index.js)
npm test             # Run Vitest tests
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3100` | HTTP server port |
| `ANTHROPIC_API_KEY` | (required) | Claude API key |
| `SIDECAR_AUTH_TOKEN` | (optional) | Bearer token for sidecar API auth; skipped if unset |
| `MINI_INFRA_API_URL` | `http://localhost:5005` | Mini Infra server base URL |
| `MINI_INFRA_API_KEY` | `""` | API key for Mini Infra REST API |
| `AGENT_MODEL` | `claude-sonnet-4-6` | LLM model identifier |
| `AGENT_TIMEOUT_MS` | `300000` | Turn timeout in ms (5 minutes) |
| `AGENT_THINKING` | `adaptive` | Thinking mode: `adaptive`, `enabled`, `disabled` |
| `AGENT_EFFORT` | `medium` | Effort level: `low`, `medium`, `high`, `max` |
| `DOCS_DIR` | `/app/docs` | Path to user documentation files |
| `LOG_LEVEL` | `info` | Pino log level: `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | — | Set to `production` for JSON logging |
| `AGENT_LOG_DIR` | `/tmp/agent-logs` | Directory for per-turn NDJSON message logs |
| `TAP_COLLECTOR_URL` | (optional) | HTTP endpoint for TAP telemetry streaming |
| `TAP_COLLECTOR_AUTH` | (optional) | Authorization header value for TAP collector |

## Diagnostics

### Per-Turn NDJSON Logs

Every SDK message (partial streaming events, complete assistant messages, tool calls, tool results, system events, and result metadata) is written to a per-turn NDJSON file at `$AGENT_LOG_DIR/<turnId>.ndjson`.

Each line is a JSON envelope:

```json
{"seq":0,"ts":"2026-04-08T12:00:00.000Z","type":"tap:query_params","message":{...}}
{"seq":1,"ts":"2026-04-08T12:00:01.000Z","type":"system","message":{...}}
{"seq":2,"ts":"2026-04-08T12:00:02.000Z","type":"stream_event","message":{...}}
```

Useful commands:

```bash
# Watch messages in real-time
tail -f /tmp/agent-logs/turn_*.ndjson | jq .

# Show only assistant text and tool use
cat /tmp/agent-logs/turn_abc123.ndjson | jq 'select(.type == "assistant" or .type == "stream_event")'

# Count messages by type
cat /tmp/agent-logs/turn_abc123.ndjson | jq -r .type | sort | uniq -c | sort -rn
```

### TAP HTTP Sink

When `TAP_COLLECTOR_URL` is set, all SDK messages are also batched (10 per batch, flushed every 2s) and POSTed to the collector endpoint. Add `TAP_COLLECTOR_AUTH` to include an Authorization header.

### Application Logs

Pino structured logging to stdout. Set `LOG_LEVEL=debug` for verbose output including tap messages. In production (`NODE_ENV=production`), logs are JSON; in development, logs are colorized and pretty-printed.

### Health Endpoint

`GET /health` (no auth required) returns:

```json
{"status":"ok","uptime":120,"activeTurns":1,"totalTurnsProcessed":5}
```

Used by Docker HEALTHCHECK (30s interval, 5s timeout).

## Architecture Notes

### Turn State Machine

```
(created) → running → completed
                ↓ ↓ ↓
             failed / timeout / cancelled
```

- Max 5 concurrent running turns, max 20 turns in memory
- Terminal turns are evicted when capacity is exceeded
- Turns track token usage, duration, and SDK session ID

### Session Resumption

The Claude Agent SDK session ID is captured from `result` messages and stored on the turn. When a follow-up message arrives with `sdkSessionId`, the runner passes it via the SDK's `resume` option to continue the conversation context.

### MCP Servers

Two per-turn MCP servers are created:
- **mini-infra-infra** — `api_request` (authenticated REST calls), `list_docs`, `read_doc`
- **mini-infra-ui** — `highlight_element` (broadcasts SSE to highlight UI), `navigate_to`, `get_current_page`

### Bash Safety

All bash commands go through `checkBashSafety()` which blocks destructive patterns (rm -rf /, mkfs, dd, /dev/ writes, kill PID 1, shutdown, reboot, git push --force) and rejects command injection vectors (backticks, `$()` subshells, newlines).
