import { ServiceError } from "./error-handler";

const SERVICE_LABELS: Record<string, string> = {
  cloudflare: "Cloudflare",
  azure: "Azure",
  docker: "Docker",
  github: "GitHub",
};

function getStatusCode(error: unknown): number | undefined {
  const e = error as any;
  return e?.status ?? e?.statusCode ?? e?.response?.status ?? undefined;
}

function getMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

interface ErrorMapping {
  test: (
    status: number | undefined,
    message: string,
    error: unknown,
  ) => boolean;
  statusCode: number;
  toMessage: (serviceName: string, message: string) => string;
}

const CLOUDFLARE_MAPPINGS: ErrorMapping[] = [
  {
    test: (status) => status === 401,
    statusCode: 401,
    toMessage: (svc) =>
      `${svc} API token is invalid or expired. Check your API token in Settings > Cloudflare.`,
  },
  {
    test: (status) => status === 403,
    statusCode: 403,
    toMessage: (svc) =>
      `${svc} API token does not have the required permission. Ensure the token has the "Cloudflare Tunnel" edit permission under Account > Zero Trust.`,
  },
  {
    test: (status) => status === 429,
    statusCode: 429,
    toMessage: (svc) =>
      `${svc} rate limit exceeded. Please wait a moment and try again.`,
  },
  {
    test: (_status, msg) => /timeout/i.test(msg),
    statusCode: 504,
    toMessage: (svc) => `${svc} request timed out. Please try again.`,
  },
  {
    test: (_status, msg) => /ENOTFOUND|ECONNREFUSED/i.test(msg),
    statusCode: 502,
    toMessage: (svc) =>
      `Cannot reach ${svc} API. Check your network connection.`,
  },
];

const AZURE_MAPPINGS: ErrorMapping[] = [
  {
    test: (_s, msg, err) =>
      (err as any)?.code === "AuthenticationFailed" ||
      msg.includes("AuthenticationFailed"),
    statusCode: 403,
    toMessage: (svc) =>
      `${svc} storage authentication failed. Check your connection string in Settings > Azure.`,
  },
  {
    test: (_s, msg) => /InvalidAccountKey/i.test(msg),
    statusCode: 401,
    toMessage: (svc) =>
      `${svc} storage account key is invalid. Update your connection string.`,
  },
  {
    test: (_status, msg) => /timeout/i.test(msg),
    statusCode: 504,
    toMessage: (svc) =>
      `${svc} storage request timed out. Please try again.`,
  },
  {
    test: (_status, msg) => /ENOTFOUND|ECONNREFUSED/i.test(msg),
    statusCode: 502,
    toMessage: (svc) =>
      `Cannot reach ${svc} storage. Check your network connection.`,
  },
];

const DOCKER_MAPPINGS: ErrorMapping[] = [
  {
    test: (status) => status === 404,
    statusCode: 404,
    toMessage: (_svc, msg) => `Docker resource not found: ${msg}`,
  },
  {
    test: (status) => status === 409,
    statusCode: 409,
    toMessage: (_svc, msg) => `Docker conflict: ${msg}`,
  },
  {
    test: (_status, msg) => /ECONNREFUSED|Cannot connect/i.test(msg),
    statusCode: 502,
    toMessage: () => `Cannot connect to Docker daemon. Is Docker running?`,
  },
];

const GITHUB_MAPPINGS: ErrorMapping[] = [
  {
    test: (status) => status === 401,
    statusCode: 401,
    toMessage: (svc) =>
      `${svc} credentials are invalid. Check your token in Settings > GitHub.`,
  },
  {
    test: (status) => status === 403,
    statusCode: 403,
    toMessage: (svc) =>
      `${svc} token does not have the required permissions.`,
  },
  {
    test: (status) => status === 404,
    statusCode: 404,
    toMessage: (svc) =>
      `${svc} repository not found. Check the repository name and token permissions.`,
  },
  {
    test: (status) => status === 429,
    statusCode: 429,
    toMessage: (svc) =>
      `${svc} rate limit exceeded. Please wait and try again.`,
  },
];

const SERVICE_MAPPINGS: Record<string, ErrorMapping[]> = {
  cloudflare: CLOUDFLARE_MAPPINGS,
  azure: AZURE_MAPPINGS,
  docker: DOCKER_MAPPINGS,
  github: GITHUB_MAPPINGS,
};

/**
 * Convert an external SDK error into a ServiceError with a user-friendly message.
 *
 * Checks service-specific mappings first (e.g., Cloudflare 403 -> "API token lacks permission").
 * Falls back to a generic "{Service} service error: {original message}" if no mapping matches.
 */
export function toServiceError(
  error: unknown,
  serviceName: string,
): ServiceError {
  const label = SERVICE_LABELS[serviceName] ?? serviceName;
  const status = getStatusCode(error);
  const message = getMessage(error);
  const mappings = SERVICE_MAPPINGS[serviceName] ?? [];

  for (const mapping of mappings) {
    if (mapping.test(status, message, error)) {
      return new ServiceError(
        mapping.toMessage(label, message),
        mapping.statusCode,
        serviceName,
      );
    }
  }

  return new ServiceError(
    `${label} service error: ${message}`,
    status && status >= 400 && status < 600 ? status : 502,
    serviceName,
  );
}
