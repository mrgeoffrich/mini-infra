import type { StackConfigFile, StackContainerConfig } from '@mini-infra/types';
import { tailscaleSidecarServiceName } from '../shared/sidecar-naming';

/**
 * `serve.json` template for `tailscale serve`. The tailscaled container reads
 * this file when `TS_SERVE_CONFIG` is set and substitutes `${TS_CERT_DOMAIN}`
 * at runtime with the device's MagicDNS hostname (e.g.
 * `<stack>-<service>-<env>.<tailnet>.ts.net`). Keeping the host literal in the file
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

const SERVE_CONFIG_FILENAME = 'serve.json';

/**
 * Directory the config volume is mounted at inside the sidecar container —
 * also the dir component of `TS_SERVE_CONFIG`.
 */
export const TAILSCALE_SERVE_CONFIG_DIR = '/etc/tailscale';

/**
 * Absolute path inside the sidecar container where tailscaled finds
 * `serve.json` — the value of the `TS_SERVE_CONFIG` env var. Equal to
 * `<TAILSCALE_SERVE_CONFIG_DIR>/<filename>`.
 */
export const TAILSCALE_SERVE_CONFIG_PATH = `${TAILSCALE_SERVE_CONFIG_DIR}/${SERVE_CONFIG_FILENAME}`;

/**
 * Path *inside the named volume* where `StackContainerManager.writeConfigFiles`
 * writes the rendered `serve.json`. The volume is mounted at
 * {@link TAILSCALE_SERVE_CONFIG_DIR} on the sidecar, so a file at this
 * in-volume path appears at {@link TAILSCALE_SERVE_CONFIG_PATH} inside the
 * container. The split mirrors the `haproxy_config` convention in
 * `server/templates/haproxy/template.json` — file path is *inside* the volume,
 * mount target is the absolute container path, the file appears at
 * `<mount-target><file-path>` at runtime.
 */
const TAILSCALE_SERVE_CONFIG_VOLUME_PATH = `/${SERVE_CONFIG_FILENAME}`;

/**
 * Volume name that holds the rendered `serve.json` for a given sidecar
 * service. Aligning with the state-volume convention (`<sidecar>-state`)
 * keeps per-application volumes grouped by the sidecar they belong to.
 */
export function tailscaleConfigVolumeName(sidecarServiceName: string): string {
  return `${sidecarServiceName}-config`;
}

export type TailscaleSidecarMount = NonNullable<
  StackContainerConfig['mounts']
>[number];

export interface ServeConfigArtifacts {
  /** Goes into `provisioned.files`; written into the named volume. */
  configFile: StackConfigFile;
  /** Goes into the sidecar's `containerConfig.mounts` so the file is readable. */
  configMount: TailscaleSidecarMount;
}

/**
 * Compose the (file, mount) pair the tailscale-web sidecar needs to read its
 * `serve.json`. Without the matching mount on the consumer sidecar, the file
 * is written into a volume nothing reads — `TS_SERVE_CONFIG` would point at a
 * non-existent path. Returning the pair from one helper keeps the two halves
 * impossible to wire up out of sync.
 */
export function buildServeConfigArtifacts(
  targetServiceName: string,
  serveJsonContent: string,
): ServeConfigArtifacts {
  const sidecarServiceName = tailscaleSidecarServiceName(targetServiceName);
  const volumeName = tailscaleConfigVolumeName(sidecarServiceName);
  return {
    configFile: {
      volumeName,
      path: TAILSCALE_SERVE_CONFIG_VOLUME_PATH,
      content: serveJsonContent,
      permissions: '0644',
    },
    configMount: {
      source: volumeName,
      target: TAILSCALE_SERVE_CONFIG_DIR,
      type: 'volume',
    },
  };
}
