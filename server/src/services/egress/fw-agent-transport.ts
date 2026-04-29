/**
 * Shared HTTP-over-Unix-socket transport for talking to the egress-fw-agent.
 *
 * The fw-agent exposes its admin API on a Unix socket (default
 * /var/run/mini-infra/fw.sock). Both the long-lived EnvFirewallManager and
 * the lifecycle FwAgentSidecar service speak to it, so the raw socket plumbing
 * lives here.
 */

import { createConnection } from 'net';

export const DEFAULT_FW_AGENT_SOCKET_PATH = '/var/run/mini-infra/fw.sock';

export interface FwAgentRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
}

export interface FwAgentResponse {
  status: number;
  body: unknown;
}

export type Fetcher = (req: FwAgentRequest) => Promise<FwAgentResponse>;

/** Returns the configured Unix socket path (env var with sensible default). */
export function getFwAgentSocketPath(): string {
  return process.env.FW_AGENT_SOCKET_PATH ?? DEFAULT_FW_AGENT_SOCKET_PATH;
}

/**
 * Default fetcher — speaks raw HTTP/1.1 over the agent's Unix domain socket.
 * Each request opens its own connection (Connection: close) since admin calls
 * are infrequent and short-lived.
 */
export function createUnixSocketFetcher(socketPath: string, timeoutMs = 5000): Fetcher {
  return (req) =>
    new Promise<FwAgentResponse>((resolve, reject) => {
      const bodyStr = req.body ? JSON.stringify(req.body) : '';
      const headers: string[] = [
        `${req.method} ${req.path} HTTP/1.1`,
        'Host: localhost',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(bodyStr)}`,
        'Connection: close',
        '',
        bodyStr,
      ];
      const rawRequest = headers.join('\r\n');

      const socket = createConnection(socketPath);
      let rawResponse = '';

      socket.setTimeout(timeoutMs);
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error(`fw-agent socket timeout: ${socketPath}`));
      });

      socket.on('error', (err) => {
        reject(new Error(`fw-agent socket error: ${err.message}`));
      });

      socket.on('data', (chunk) => {
        rawResponse += chunk.toString('utf-8');
      });

      socket.on('end', () => {
        try {
          const lines = rawResponse.split('\r\n');
          const statusLine = lines[0] ?? '';
          const statusMatch = statusLine.match(/HTTP\/1\.[01] (\d+)/);
          const status = statusMatch ? parseInt(statusMatch[1], 10) : 500;

          const bodyStart = rawResponse.indexOf('\r\n\r\n');
          const rawBody = bodyStart >= 0 ? rawResponse.slice(bodyStart + 4) : '';
          let body: unknown;
          try {
            body = rawBody ? JSON.parse(rawBody) : null;
          } catch {
            body = rawBody;
          }
          resolve({ status, body });
        } catch (err) {
          reject(err);
        }
      });

      socket.write(rawRequest);
    });
}
