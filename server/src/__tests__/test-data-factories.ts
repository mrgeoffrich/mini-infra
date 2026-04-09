import { createId } from "@paralleldrive/cuid2";
import type {
  CreatePostgresDatabaseRequest,
  CreateRegistryCredentialRequest,
  UpdateRegistryCredentialRequest,
} from "@mini-infra/types";

function nextTestToken(prefix: string): string {
  return `${prefix}-${createId()}`.toLowerCase();
}

export function uniqueTestValue(prefix: string = "test"): string {
  return nextTestToken(prefix);
}

export function buildRegistryCredentialRequest(
  overrides: Partial<CreateRegistryCredentialRequest> = {},
): CreateRegistryCredentialRequest {
  const token = nextTestToken("registry");

  return {
    name: `Registry ${token}`,
    registryUrl: `${token}.example.com`,
    username: `user-${token}`,
    password: `pass-${token}`,
    isDefault: false,
    isActive: true,
    description: `Test registry ${token}`,
    ...overrides,
  };
}

export function buildRegistryCredentialUpdateRequest(
  overrides: Partial<UpdateRegistryCredentialRequest> = {},
): UpdateRegistryCredentialRequest {
  const token = nextTestToken("registry-update");

  return {
    name: `Updated Registry ${token}`,
    username: `updated-${token}`,
    password: `updated-pass-${token}`,
    description: `Updated registry ${token}`,
    ...overrides,
  };
}

export function buildPostgresDatabaseRequest(
  overrides: Partial<CreatePostgresDatabaseRequest> = {},
): CreatePostgresDatabaseRequest {
  const token = nextTestToken("postgres");

  return {
    name: `${token}-config`,
    host: `${token}.db.internal`,
    port: 5432,
    database: `${token.replace(/-/g, "_")}_db`,
    username: `${token.replace(/-/g, "_")}_user`,
    password: `pass-${token}`,
    sslMode: "prefer",
    tags: [token],
    ...overrides,
  };
}

export function buildSystemSettingRecord(
  userId: string,
  overrides: Partial<{
    category: string;
    key: string;
    value: string;
    isEncrypted: boolean;
    isActive: boolean;
    createdBy: string;
    updatedBy: string;
  }> = {},
) {
  return {
    category: "docker",
    key: "host",
    value: "unix:///var/run/docker.sock",
    isEncrypted: false,
    isActive: true,
    createdBy: userId,
    updatedBy: userId,
    ...overrides,
  };
}
