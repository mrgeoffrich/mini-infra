/**
 * `serve.json` template for `tailscale serve`. The tailscaled container reads
 * this file when `TS_SERVE_CONFIG` is set and substitutes `${TS_CERT_DOMAIN}`
 * at runtime with the device's MagicDNS hostname (e.g.
 * `<service>-<env>.<tailnet>.ts.net`). Keeping the host literal in the file
 * means the sidecar works identically across tailnets without re-rendering
 * the file at apply time.
 *
 * Shared between the solo `tailscale-web` provision step and the
 * `kind: tailscale` merge strategy so they emit byte-identical config when
 * the (target, port, path) tuple matches.
 */
export interface ServeConfigInput {
  /** Service name of the target on the shared Docker network. */
  targetService: string;
  /** Port on the target service the sidecar proxies to. */
  targetPort: number;
  /** URL path prefix exposed on the tailnet host; defaults to `/`. */
  path?: string;
}

export function renderServeJson(input: ServeConfigInput): string {
  const path = input.path && input.path.length > 0 ? input.path : '/';
  const proxy = `http://${input.targetService}:${input.targetPort}`;
  const config = {
    TCP: {
      '443': { HTTPS: true },
    },
    Web: {
      '${TS_CERT_DOMAIN}:443': {
        Handlers: {
          [path]: { Proxy: proxy },
        },
      },
    },
    AllowFunnel: {
      '${TS_CERT_DOMAIN}:443': false,
    },
  };
  return JSON.stringify(config, null, 2);
}

/** Path inside the sidecar where the rendered `serve.json` is mounted. */
export const TAILSCALE_SERVE_CONFIG_PATH = '/etc/tailscale/serve.json';

/**
 * Volume name that holds the rendered `serve.json` for a given sidecar
 * service. Aligning with the state-volume convention (`<sidecar>-state`)
 * keeps per-application volumes grouped by the sidecar they belong to.
 */
export function tailscaleConfigVolumeName(sidecarServiceName: string): string {
  return `${sidecarServiceName}-config`;
}
