import { getLogger } from "../lib/logger-factory";

const logger = getLogger("docker", "image-inspect");

const DOCKER_HUB_AUTH = "https://auth.docker.io/token";
const TIMEOUT_MS = 10000;

interface ImageReference {
  registry: string;
  repository: string;
  isDockerHub: boolean;
}

interface Credentials {
  username: string;
  password: string;
}

export class ImageInspectService {
  private credentials: Credentials | null;

  constructor(credentials?: Credentials | null) {
    this.credentials = credentials ?? null;
  }

  /**
   * Parse an image name into registry, repository, and whether it's Docker Hub.
   */
  parseImageReference(image: string): ImageReference {
    const parts = image.split("/");

    if (parts.length === 1) {
      return {
        registry: "registry-1.docker.io",
        repository: `library/${parts[0]}`,
        isDockerHub: true,
      };
    }

    const firstPart = parts[0];
    if (firstPart.includes(".") || firstPart.includes(":")) {
      return {
        registry: firstPart,
        repository: parts.slice(1).join("/"),
        isDockerHub: false,
      };
    }

    return {
      registry: "registry-1.docker.io",
      repository: image,
      isDockerHub: true,
    };
  }

  /**
   * Fetch exposed ports from a Docker image without pulling it.
   * Queries the registry V2 API for the manifest and config blob.
   */
  async getExposedPorts(image: string, tag: string): Promise<number[]> {
    const ref = this.parseImageReference(image);
    const authHeader = await this.getAuthHeader(ref);

    const registryBase = ref.registry.startsWith("localhost")
      ? `http://${ref.registry}`
      : `https://${ref.registry}`;

    // 1. Fetch manifest (may be a manifest list for multi-arch images)
    const manifestUrl = `${registryBase}/v2/${ref.repository}/manifests/${tag}`;
    const manifestRes = await this.fetchWithTimeout(manifestUrl, {
      headers: {
        Accept: [
          "application/vnd.docker.distribution.manifest.v2+json",
          "application/vnd.oci.image.manifest.v1+json",
          "application/vnd.docker.distribution.manifest.list.v2+json",
          "application/vnd.oci.image.index.v1+json",
        ].join(", "),
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
    });

    if (!manifestRes.ok) {
      if (manifestRes.status === 404) throw new Error("Image not found");
      if (manifestRes.status === 401) throw new Error("Authentication failed");
      throw new Error(`Registry returned ${manifestRes.status}`);
    }

    let manifest = await manifestRes.json();

    // Handle manifest list (multi-arch) — resolve to amd64/linux manifest
    if (manifest.manifests && !manifest.config) {
      const amd64 = manifest.manifests.find(
        (m: { platform?: { architecture?: string; os?: string } }) => m.platform?.architecture === "amd64" && m.platform?.os === "linux",
      ) ?? manifest.manifests.find(
        (m: { platform?: { architecture?: string; os?: string } }) => m.platform?.os === "linux",
      ) ?? manifest.manifests[0];

      if (!amd64?.digest) {
        logger.warn({ image, tag }, "Manifest list has no resolvable entry");
        return [];
      }

      const archManifestRes = await this.fetchWithTimeout(
        `${registryBase}/v2/${ref.repository}/manifests/${amd64.digest}`,
        {
          headers: {
            Accept: "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
            ...(authHeader ? { Authorization: authHeader } : {}),
          },
        },
      );

      if (!archManifestRes.ok) {
        throw new Error(`Failed to fetch arch manifest: ${archManifestRes.status}`);
      }

      manifest = await archManifestRes.json();
    }

    const configDigest = manifest.config?.digest;
    if (!configDigest) {
      logger.warn({ image, tag }, "Manifest has no config digest");
      return [];
    }

    // 2. Fetch config blob
    const blobUrl = `${registryBase}/v2/${ref.repository}/blobs/${configDigest}`;
    const blobRes = await this.fetchWithTimeout(blobUrl, {
      headers: {
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
    });

    if (!blobRes.ok) {
      throw new Error(`Failed to fetch config blob: ${blobRes.status}`);
    }

    const config = await blobRes.json();
    const exposedPorts = config.config?.ExposedPorts ?? {};

    // Parse "80/tcp" -> 80, sort numerically
    const ports = Object.keys(exposedPorts)
      .map((key) => parseInt(key.split("/")[0], 10))
      .filter((p) => !isNaN(p))
      .sort((a, b) => a - b);

    logger.info({ image, tag, ports }, "Detected exposed ports from registry");
    return ports;
  }

  private async getAuthHeader(ref: ImageReference): Promise<string | null> {
    if (ref.isDockerHub) {
      return this.getDockerHubToken(ref.repository);
    }

    if (this.credentials) {
      const encoded = Buffer.from(
        `${this.credentials.username}:${this.credentials.password}`,
      ).toString("base64");
      return `Basic ${encoded}`;
    }

    return null;
  }

  private async getDockerHubToken(repository: string): Promise<string> {
    const params = new URLSearchParams({
      service: "registry.docker.io",
      scope: `repository:${repository}:pull`,
    });

    const url = `${DOCKER_HUB_AUTH}?${params}`;
    const headers: Record<string, string> = {};

    if (this.credentials) {
      const encoded = Buffer.from(
        `${this.credentials.username}:${this.credentials.password}`,
      ).toString("base64");
      headers.Authorization = `Basic ${encoded}`;
    }

    const res = await this.fetchWithTimeout(url, { headers });
    if (!res.ok) {
      throw new Error("Failed to obtain Docker Hub token");
    }

    const data = await res.json();
    return `Bearer ${data.token}`;
  }

  private async fetchWithTimeout(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
