/**
 * Regression tests for the built-in `cloudflare-tunnel` connector template.
 *
 * The `cloudflare/cloudflared` image is fully distroless: its only executable
 * is `/usr/local/bin/cloudflared` — there is no `/bin/sh`, no `wget`, no
 * `curl`. An earlier revision shipped a healthcheck of the form
 *   ["CMD-SHELL", "wget --spider -q http://localhost:2000/ready || exit 1"]
 * which could never pass against that image because:
 *   1. CMD-SHELL wraps the command in `/bin/sh -c`, and there is no shell.
 *   2. `wget` is not present.
 *   3. cloudflared binds its metrics/`/ready` server to a *random* port unless
 *      `--metrics` / `$TUNNEL_METRICS` pins it — never port 2000.
 * The stack therefore sat in `error` ("Healthcheck timeout") even though the
 * tunnel itself was connected and healthy.
 *
 * The fix pins the metrics server to a fixed loopback port via the
 * `TUNNEL_METRICS` env var (read by both the `run` process and the probe) and
 * uses cloudflared's own exec-form `tunnel ready` subcommand as the
 * healthcheck. These tests pin that shape so it cannot regress back to a
 * shell/wget probe the image cannot execute.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { loadTemplateFromDirectory } from '../services/stacks/template-file-loader';

const TEMPLATES_DIR = path.resolve(process.cwd(), 'templates');

function loadTunnel() {
  return loadTemplateFromDirectory(path.join(TEMPLATES_DIR, 'cloudflare-tunnel'));
}

describe('cloudflare-tunnel template.json', () => {
  it('parses successfully via loadTemplateFromDirectory', () => {
    expect(() => loadTunnel()).not.toThrow();
  });

  it('has a single cloudflared service', () => {
    const loaded = loadTunnel();
    expect(loaded.definition.services).toHaveLength(1);
    expect(loaded.definition.services[0].serviceName).toBe('cloudflared');
  });

  it('pins the cloudflared metrics server to a fixed loopback port via TUNNEL_METRICS', () => {
    const svc = loadTunnel().definition.services[0];
    // Without this, cloudflared binds /ready to a random port and the
    // healthcheck (and any operator probe) can never find it.
    expect(svc.containerConfig.env?.TUNNEL_METRICS).toBe('127.0.0.1:2000');
  });

  it('keeps the static TUNNEL_METRICS env disjoint from the dynamic TUNNEL_TOKEN', () => {
    const svc = loadTunnel().definition.services[0];
    const staticKeys = Object.keys(svc.containerConfig.env ?? {});
    const dynamicKeys = Object.keys(svc.containerConfig.dynamicEnv ?? {});
    expect(staticKeys).toContain('TUNNEL_METRICS');
    expect(dynamicKeys).toContain('TUNNEL_TOKEN');
    expect(staticKeys.filter((k) => dynamicKeys.includes(k))).toEqual([]);
  });

  it('uses the distroless-safe exec-form `cloudflared tunnel ready` healthcheck', () => {
    const svc = loadTunnel().definition.services[0];
    const test = svc.containerConfig.healthcheck?.test;
    // Exec form (no shell) using the only binary present in the image.
    expect(test).toEqual(['CMD', 'cloudflared', 'tunnel', 'ready']);
  });

  it('does not use a shell-form healthcheck or external probe binaries', () => {
    const svc = loadTunnel().definition.services[0];
    const test = svc.containerConfig.healthcheck?.test ?? [];
    // The cloudflared image is distroless — guard against reintroducing a
    // CMD-SHELL/wget/curl probe that the image cannot run.
    expect(test[0]).not.toBe('CMD-SHELL');
    expect(test.join(' ')).not.toMatch(/\b(wget|curl)\b/);
  });

  it('bypasses egress injection — cloudflared is an ingress connector, not firewalled egress', () => {
    const svc = loadTunnel().definition.services[0];
    // cloudflared reaches its internal HAProxy origin AND the Cloudflare edge.
    // With HTTP_PROXY injected it tries to CONNECT through the egress-gateway
    // proxy (which it can't even resolve — it only joins the `tunnel` network),
    // so the origin is unreachable and the tunnel serves a Cloudflare error.
    // Treat it like the other infra containers (egress-gateway, fw-agent).
    expect(svc.containerConfig.egressBypass).toBe(true);
    // A bypassed service must not also carry an egress allowlist — it never
    // touches the proxy, so `requiredEgress` would be dead and misleading.
    expect(svc.containerConfig.requiredEgress).toBeUndefined();
  });
});
