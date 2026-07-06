import { describe, it, expect, vi, beforeEach } from "vitest";
import { getRegistryAuthHeader } from "../services/registry-auth";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function headersWithWwwAuthenticate(value: string | null) {
  return {
    get: (name: string) =>
      name.toLowerCase() === "www-authenticate" ? value : null,
  };
}

describe("getRegistryAuthHeader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no credentials are supplied", async () => {
    const result = await getRegistryAuthHeader("ghcr.io", "owner/repo");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("exchanges Basic credentials for a Bearer token when the registry issues a challenge (GHCR)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: headersWithWwwAuthenticate(
        'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
      ),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "exchanged-bearer-token" }),
    });

    const result = await getRegistryAuthHeader(
      "ghcr.io",
      "owner/repo",
      "user",
      "pat-token",
    );

    expect(result).toBe("Bearer exchanged-bearer-token");

    const [probeUrl] = mockFetch.mock.calls[0];
    expect(probeUrl).toBe("https://ghcr.io/v2/");

    const [tokenUrl, tokenInit] = mockFetch.mock.calls[1];
    expect(tokenUrl).toContain("https://ghcr.io/token?");
    expect(tokenUrl).toContain("service=ghcr.io");
    expect(decodeURIComponent(tokenUrl)).toContain("repository:owner/repo:pull");
    expect(tokenInit.headers.Authorization).toBe(
      `Basic ${Buffer.from("user:pat-token").toString("base64")}`,
    );
  });

  it("supports access_token as an alternative token field", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: headersWithWwwAuthenticate(
        'Bearer realm="https://example.com/token",service="example.com"',
      ),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "alt-token" }),
    });

    const result = await getRegistryAuthHeader(
      "example.com",
      "owner/repo",
      "user",
      "pass",
    );

    expect(result).toBe("Bearer alt-token");
  });

  it("falls back to Basic auth when the registry issues no Bearer challenge", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: headersWithWwwAuthenticate(null),
    });

    const result = await getRegistryAuthHeader(
      "private-registry.example.com",
      "owner/repo",
      "user",
      "pass",
    );

    expect(result).toBe(
      `Basic ${Buffer.from("user:pass").toString("base64")}`,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to Basic auth when the token exchange fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: headersWithWwwAuthenticate(
        'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
      ),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const result = await getRegistryAuthHeader(
      "ghcr.io",
      "owner/repo",
      "user",
      "pat-token",
    );

    expect(result).toBe(
      `Basic ${Buffer.from("user:pat-token").toString("base64")}`,
    );
  });

  it("falls back to Basic auth when the challenge probe throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const result = await getRegistryAuthHeader(
      "ghcr.io",
      "owner/repo",
      "user",
      "pat-token",
    );

    expect(result).toBe(
      `Basic ${Buffer.from("user:pat-token").toString("base64")}`,
    );
  });

  it("probes over plain HTTP for localhost registries", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: headersWithWwwAuthenticate(null),
    });

    await getRegistryAuthHeader("localhost:5000", "owner/repo", "user", "pass");

    expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:5000/v2/");
  });
});
