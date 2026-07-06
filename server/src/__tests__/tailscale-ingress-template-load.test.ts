/**
 * Unit tests for the host-scoped `tailscale-ingress` template (Network Access
 * plan, Phase 1). Asserts:
 *
 *   - The template parses through loadTemplateFromDirectory (so it will not
 *     blow up syncBuiltinStacks at boot).
 *   - It is host-scoped and publishes a self-joined docker-network output so
 *     Mini Infra's own container attaches to the sidecar's network.
 *   - The tailscaled sidecar carries the proven credential/container shape:
 *     the tailscale/tailscale:stable image, NET_ADMIN+SYS_MODULE, the TS_*
 *     env, TS_AUTHKEY via the new `tailscale-authkey` dynamicEnv resolver, and
 *     the serve.json config file mounted at TS_SERVE_CONFIG.
 *   - serve.json proxies the tailnet host to Mini Infra's own container and
 *     keeps Funnel disabled (tailnet-private-only, per the plan's non-goals).
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { TAILSCALE_INGRESS_DEFAULT_HOSTNAME } from '@mini-infra/types';
import { loadTemplateFromDirectory } from '../services/stacks/template-file-loader';

const TEMPLATES_DIR = path.resolve(process.cwd(), 'templates');
const load = () => loadTemplateFromDirectory(path.join(TEMPLATES_DIR, 'tailscale-ingress'));

describe('tailscale-ingress template.json', () => {
  it('parses successfully via loadTemplateFromDirectory', () => {
    expect(() => load()).not.toThrow();
  });

  it('is host-scoped', () => {
    expect(load().scope).toBe('host');
  });

  it('publishes a self-joined tailscale-ingress docker-network resourceOutput', () => {
    const outputs = load().definition.resourceOutputs ?? [];
    const net = outputs.find(
      (o) => o.type === 'docker-network' && o.purpose === 'tailscale-ingress',
    );
    expect(net).toBeDefined();
    expect(net?.joinSelf).toBe(true);
  });

  it('exposes a hostname parameter whose default matches the shared constant', () => {
    const params = load().definition.parameters ?? [];
    const hostname = params.find((p) => p.name === 'hostname');
    expect(hostname).toBeDefined();
    // Pin the template default to the constant the ingress-status endpoint uses
    // to match the device — they must never drift.
    expect(hostname?.default).toBe(TAILSCALE_INGRESS_DEFAULT_HOSTNAME);
  });

  it('declares the state and config volumes', () => {
    const volumes = load().definition.volumes.map((v) => v.name);
    expect(volumes).toContain('tailscale_ingress_state');
    expect(volumes).toContain('tailscale_ingress_config');
  });

  it('runs a single tailscaled sidecar on the tailscale-ingress network with tailscale/tailscale:stable', () => {
    const services = load().definition.services;
    expect(services).toHaveLength(1);
    const svc = services[0];
    expect(svc.serviceName).toBe('tailscaled');
    expect(svc.dockerImage).toBe('tailscale/tailscale');
    expect(svc.dockerTag).toBe('stable');
    expect(svc.containerConfig.joinResourceNetworks).toEqual(['tailscale-ingress']);
  });

  it('grants NET_ADMIN + SYS_MODULE for kernel-mode tailscaled', () => {
    const svc = load().definition.services[0];
    expect(svc.containerConfig.capAdd).toEqual(['NET_ADMIN', 'SYS_MODULE']);
  });

  it('injects TS_AUTHKEY via the tailscale-authkey dynamicEnv resolver, disjoint from static env', () => {
    const cfg = load().definition.services[0].containerConfig;
    expect(cfg.dynamicEnv?.TS_AUTHKEY).toEqual({ kind: 'tailscale-authkey' });
    // TS_AUTHKEY must live only in dynamicEnv — the schema forbids env/dynamicEnv
    // key overlap, so a stray static TS_AUTHKEY would fail template load.
    expect(cfg.env?.TS_AUTHKEY).toBeUndefined();
  });

  it('sets the static TS_* env for kernel-mode serve', () => {
    const env = load().definition.services[0].containerConfig.env ?? {};
    expect(env.TS_USERSPACE).toBe('false');
    expect(env.TS_STATE_DIR).toBe('/var/lib/tailscale');
    expect(env.TS_SERVE_CONFIG).toBe('/etc/tailscale/serve.json');
    // hostname is param-substituted at instantiate time.
    expect(env.TS_HOSTNAME).toBe('{{params.hostname}}');
  });

  it('mounts serve.json at TS_SERVE_CONFIG via the config volume', () => {
    const loaded = load();
    const cfgFile = loaded.configFiles.find((f) => f.fileName === 'serve.json');
    expect(cfgFile).toBeDefined();
    expect(cfgFile?.volumeName).toBe('tailscale_ingress_config');
    // config volume mounted at /etc/tailscale + in-volume /serve.json =>
    // /etc/tailscale/serve.json, which is TS_SERVE_CONFIG.
    expect(cfgFile?.mountPath).toBe('/serve.json');
    const mounts = loaded.definition.services[0].containerConfig.mounts ?? [];
    expect(
      mounts.some((m) => m.source === 'tailscale_ingress_config' && m.target === '/etc/tailscale'),
    ).toBe(true);
  });

  it('serve.json proxies the tailnet host to Mini Infra own container with Funnel disabled', () => {
    const loaded = load();
    const cfgFile = loaded.configFiles.find((f) => f.fileName === 'serve.json');
    const serve = JSON.parse(cfgFile?.content ?? '{}');
    expect(serve.TCP?.['443']?.HTTPS).toBe(true);
    expect(serve.Web?.['${TS_CERT_DOMAIN}:443']?.Handlers?.['/']?.Proxy).toBe(
      'http://mini-infra:5000',
    );
    // Non-goal: no Funnel / public-internet exposure of the control plane.
    expect(serve.AllowFunnel?.['${TS_CERT_DOMAIN}:443']).toBe(false);
  });
});
