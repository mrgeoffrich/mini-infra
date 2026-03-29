import { describe, it, expect, vi, beforeEach } from "vitest";
import { ImageInspectService } from "../services/image-inspect";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("ImageInspectService", () => {
  let service: ImageInspectService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ImageInspectService();
  });

  describe("getExposedPorts", () => {
    it("returns exposed ports from a Docker Hub official image", async () => {
      // Token exchange response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: "test-token" }),
      });
      // Manifest response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: { digest: "sha256:abc123" },
        }),
      });
      // Config blob response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: {
            ExposedPorts: { "80/tcp": {}, "443/tcp": {} },
          },
        }),
      });

      const ports = await service.getExposedPorts("nginx", "latest");

      expect(ports).toEqual([80, 443]);
      // Verify token request went to Docker Hub auth
      expect(mockFetch.mock.calls[0][0]).toContain("auth.docker.io/token");
      expect(decodeURIComponent(mockFetch.mock.calls[0][0])).toContain("repository:library/nginx");
    });

    it("returns exposed ports from a Docker Hub user image", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: "test-token" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: { digest: "sha256:abc123" },
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: {
            ExposedPorts: { "3000/tcp": {} },
          },
        }),
      });

      const ports = await service.getExposedPorts("myuser/myapp", "v1");

      expect(ports).toEqual([3000]);
      expect(decodeURIComponent(mockFetch.mock.calls[0][0])).toContain("repository:myuser/myapp");
    });

    it("returns exposed ports from GHCR with credentials", async () => {
      const creds = { username: "user", password: "pat-token" };
      service = new ImageInspectService(creds);

      // GHCR manifest (no separate token exchange needed with Basic auth)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: { digest: "sha256:def456" },
        }),
      });
      // Config blob
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: {
            ExposedPorts: { "8080/tcp": {} },
          },
        }),
      });

      const ports = await service.getExposedPorts("ghcr.io/owner/repo", "latest");

      expect(ports).toEqual([8080]);
      // Verify Basic auth header was sent
      const manifestCall = mockFetch.mock.calls[0];
      expect(manifestCall[1].headers.Authorization).toMatch(/^Basic /);
    });

    it("returns empty array when image has no exposed ports", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: "test-token" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: { digest: "sha256:abc123" },
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: {},
        }),
      });

      const ports = await service.getExposedPorts("alpine", "latest");

      expect(ports).toEqual([]);
    });

    it("throws on image not found (404)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: "test-token" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(
        service.getExposedPorts("nonexistent/image", "latest"),
      ).rejects.toThrow("Image not found");
    });

    it("throws on auth failure (401)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: "test-token" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      await expect(
        service.getExposedPorts("private/image", "latest"),
      ).rejects.toThrow("Authentication failed");
    });

    it("throws on timeout", async () => {
      mockFetch.mockImplementationOnce(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error("AbortError")), 100)),
      );

      await expect(
        service.getExposedPorts("slow/image", "latest"),
      ).rejects.toThrow();
    });
  });

  describe("parseImageReference", () => {
    it("parses official Docker Hub images", () => {
      const result = service.parseImageReference("nginx");
      expect(result).toEqual({
        registry: "registry-1.docker.io",
        repository: "library/nginx",
        isDockerHub: true,
      });
    });

    it("parses Docker Hub user images", () => {
      const result = service.parseImageReference("myuser/myapp");
      expect(result).toEqual({
        registry: "registry-1.docker.io",
        repository: "myuser/myapp",
        isDockerHub: true,
      });
    });

    it("parses GHCR images", () => {
      const result = service.parseImageReference("ghcr.io/owner/repo");
      expect(result).toEqual({
        registry: "ghcr.io",
        repository: "owner/repo",
        isDockerHub: false,
      });
    });

    it("parses images with custom registry and port", () => {
      const result = service.parseImageReference("localhost:5000/myimage");
      expect(result).toEqual({
        registry: "localhost:5000",
        repository: "myimage",
        isDockerHub: false,
      });
    });
  });
});
