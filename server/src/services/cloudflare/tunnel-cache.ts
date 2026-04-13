import {
  CloudflareTunnelInfo,
  CloudflareTunnelConfig,
} from "@mini-infra/types";

/**
 * In-memory TTL cache for Cloudflare tunnel API responses.
 *
 * The Cloudflare API is comparatively slow and the tunnel UI polls
 * frequently — caching for a minute keeps navigation snappy while still
 * picking up changes within a reasonable window. The cache is shared
 * across every route that reads tunnel data so a list fetch and a
 * detail fetch aren't counted as separate trips.
 */
type CacheEntry =
  | { kind: "list"; data: CloudflareTunnelInfo[] }
  | { kind: "tunnel"; data: CloudflareTunnelInfo }
  | { kind: "config"; data: CloudflareTunnelConfig };

interface StoredEntry {
  entry: CacheEntry;
  expiresAt: number;
}

const TTL_MS = 60_000;
const store = new Map<string, StoredEntry>();

function read(key: string, kind: CacheEntry["kind"]): CacheEntry | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    store.delete(key);
    return null;
  }
  if (hit.entry.kind !== kind) return null;
  return hit.entry;
}

function write(key: string, entry: CacheEntry): void {
  store.set(key, { entry, expiresAt: Date.now() + TTL_MS });
}

export const tunnelCache = {
  getList(): CloudflareTunnelInfo[] | null {
    const hit = read("tunnels_list", "list");
    return hit?.kind === "list" ? hit.data : null;
  },
  setList(data: CloudflareTunnelInfo[]): void {
    write("tunnels_list", { kind: "list", data });
  },
  getTunnel(tunnelId: string): CloudflareTunnelInfo | null {
    const hit = read(`tunnel_${tunnelId}`, "tunnel");
    return hit?.kind === "tunnel" ? hit.data : null;
  },
  setTunnel(tunnelId: string, data: CloudflareTunnelInfo): void {
    write(`tunnel_${tunnelId}`, { kind: "tunnel", data });
  },
  getConfig(tunnelId: string): CloudflareTunnelConfig | null {
    const hit = read(`tunnel_config_${tunnelId}`, "config");
    return hit?.kind === "config" ? hit.data : null;
  },
  setConfig(tunnelId: string, data: CloudflareTunnelConfig): void {
    write(`tunnel_config_${tunnelId}`, { kind: "config", data });
  },
  clear(): void {
    store.clear();
  },
};
