/**
 * Regression tests for the built-in `haproxy` load-balancer template.
 *
 * HAProxy is the environment's *internal* router — its backends are all
 * container-local, and it never makes controlled internet egress. When the
 * egress firewall injected HTTP_PROXY/HTTPS_PROXY into it, the container had to
 * carry a defensive `unset HTTP_PROXY …` in its healthcheck so the localhost
 * stats probe wouldn't be routed through the (often unreachable) egress-gateway
 * proxy. Marking the service `egressBypass: true` removes the proxy env at the
 * source and keeps HAProxy out of the egress firewall's scope entirely, the
 * same way the egress-gateway and fw-agent infra containers are handled.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { loadTemplateFromDirectory } from '../services/stacks/template-file-loader';

const TEMPLATES_DIR = path.resolve(process.cwd(), 'templates');

function loadHaproxy() {
  return loadTemplateFromDirectory(path.join(TEMPLATES_DIR, 'haproxy'));
}

describe('haproxy template.json', () => {
  it('parses successfully via loadTemplateFromDirectory', () => {
    expect(() => loadHaproxy()).not.toThrow();
  });

  it('has a single haproxy service', () => {
    const loaded = loadHaproxy();
    expect(loaded.definition.services).toHaveLength(1);
    expect(loaded.definition.services[0].serviceName).toBe('haproxy');
  });

  it('bypasses egress injection — HAProxy is an internal router, not firewalled egress', () => {
    const svc = loadHaproxy().definition.services[0];
    expect(svc.containerConfig.egressBypass).toBe(true);
  });
});
