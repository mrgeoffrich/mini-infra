/**
 * Naming conventions for Tailscale-addon sidecars. Centralised so the
 * `tailscale-ssh` addon, the `tailscale-web` addon, and the `kind: tailscale`
 * merge strategy all emit the same service / volume names — a merged sidecar
 * shares one device record, one state volume, and one rendered service row
 * with whichever solo addon application would have produced it on its own.
 */

/**
 * Synthetic sidecar service name for the tailscale family. Solo and merged
 * applications both render under `<target>-tailscale` (no instance) so the
 * rendered stack has at most one sidecar per target service regardless of
 * which Tailscale addons are declared.
 *
 * When `instanceId` is supplied (pool-instance expansion — Phase 6), the
 * sidecar gets a per-instance service-name suffix so the renderer can emit
 * N sidecar definitions for one pool service without colliding on
 * `serviceName`. The pool spawner consumes these names when creating the
 * per-instance sidecar containers; the reaper resolves them back via the
 * `mini-infra.pool-instance-id` label on the container, not the name.
 */
export function tailscaleSidecarServiceName(
  targetServiceName: string,
  instanceId?: string,
): string {
  if (instanceId) {
    return `${targetServiceName}-tailscale-${instanceId}`;
  }
  return `${targetServiceName}-tailscale`;
}

/**
 * Per-application state volume name. tailscaled persists node identity here
 * so restarts re-use the same device record (with `ephemeral: true` the node
 * de-registers on shutdown and the volume just holds runtime state).
 */
export function tailscaleStateVolumeName(sidecarServiceName: string): string {
  return `${sidecarServiceName}-state`;
}
