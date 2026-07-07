/**
 * Pure hostname composition helpers shared by the routing UI. Splitting a full
 * hostname into `subdomain` + `zone` (and rebuilding it) is used both to seed
 * the routing form from an existing value and to keep the hidden `hostname`
 * field in sync as the user types.
 */

export function buildHostname(subdomain: string, zone: string): string {
  const sub = subdomain.trim().replace(/^\.+|\.+$/g, "");
  if (!zone) return sub;
  if (!sub) return zone;
  return `${sub}.${zone}`;
}

export function decomposeHostname(
  hostname: string,
  zones: { name: string }[],
): { subdomain: string; zone: string } {
  for (const z of zones) {
    if (hostname === z.name) return { subdomain: "", zone: z.name };
    if (hostname.endsWith(`.${z.name}`)) {
      return {
        subdomain: hostname.slice(0, -(z.name.length + 1)),
        zone: z.name,
      };
    }
  }
  return { subdomain: hostname, zone: "" };
}
