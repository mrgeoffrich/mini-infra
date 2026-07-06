import dns from "node:dns";
import net from "node:net";

/**
 * How long Node's Happy Eyeballs (`autoSelectFamily`) waits for one connection
 * attempt before racing the next address. Node's default is **250ms**, which is
 * shorter than real-world cross-region connect latency and is the actual cause
 * of the Tailscale connector failure below. 2s gives ample headroom for slow
 * links while still failing over within a couple of seconds if an address is
 * genuinely dead.
 */
const OUTBOUND_FAMILY_ATTEMPT_TIMEOUT_MS = 2000;

/**
 * Make the server's outbound connections robust on high-latency and no-IPv6
 * links — the way `curl` and browsers already are.
 *
 * Field failure this fixes: outbound `fetch` to `api.tailscale.com` (which
 * publishes both AAAA and A records) failed with a bare `TypeError: fetch
 * failed` after ~4s on a host behind a CGNAT / no-IPv6 ISP, even though a plain
 * `net.connect` to the very same IPv4 address succeeded in ~280ms. The cause
 * was Node's Happy Eyeballs (`autoSelectFamily`, default-on since Node 20):
 *   - it races each resolved address with `autoSelectFamilyAttemptTimeout`
 *     (**250ms** default) between attempts, and
 *   - the real TLS-capable connect to Tailscale's anycast IPs took ~280ms,
 *     i.e. *just over* that budget — so every IPv4 attempt was abandoned at
 *     250ms (`ETIMEDOUT`) while every IPv6 attempt was `EHOSTUNREACH`, and the
 *     whole request failed after cycling through all 32 addresses.
 *
 * `curl` worked because its Happy Eyeballs doesn't kill a healthy in-flight
 * connection. The fix mirrors that:
 *   - `net.setDefaultAutoSelectFamilyAttemptTimeout(2000)` — the load-bearing
 *     fix: don't abandon a connection that just needs a bit longer than 250ms.
 *   - `dns.setDefaultResultOrder("ipv4first")` — on a no-IPv6 host, try the
 *     reachable IPv4 family first (Node's own default before v17; harmless on
 *     dual-stack hosts).
 *   - `net.setDefaultAutoSelectFamily(true)` — keep Happy Eyeballs on
 *     explicitly, so IPv6-only / IPv4-broken destinations still fail over.
 *
 * Must run before any module makes an outbound request — call it first thing in
 * server bootstrap, right after logging config. Kept dependency-free (only
 * `node:dns` / `node:net`) so it is safe to import at the very top of boot.
 *
 * Returns the applied state so the caller can log it (and so it is unit
 * testable). Never throws — a runtime that lacks these APIs simply keeps its
 * defaults.
 */
export function configureOutboundNetworking(): {
  dnsResultOrder: string;
  autoSelectFamily: boolean | "unknown";
  autoSelectFamilyAttemptTimeoutMs: number | "unknown";
} {
  if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === "function") {
    net.setDefaultAutoSelectFamilyAttemptTimeout(
      OUTBOUND_FAMILY_ATTEMPT_TIMEOUT_MS,
    );
  }
  if (typeof net.setDefaultAutoSelectFamily === "function") {
    net.setDefaultAutoSelectFamily(true);
  }
  if (typeof dns.setDefaultResultOrder === "function") {
    dns.setDefaultResultOrder("ipv4first");
  }

  return {
    dnsResultOrder:
      typeof dns.getDefaultResultOrder === "function"
        ? dns.getDefaultResultOrder()
        : "unknown",
    autoSelectFamily:
      typeof net.getDefaultAutoSelectFamily === "function"
        ? net.getDefaultAutoSelectFamily()
        : "unknown",
    autoSelectFamilyAttemptTimeoutMs:
      typeof net.getDefaultAutoSelectFamilyAttemptTimeout === "function"
        ? net.getDefaultAutoSelectFamilyAttemptTimeout()
        : "unknown",
  };
}
