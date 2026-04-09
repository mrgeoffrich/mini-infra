import { testPrisma } from "./integration-test-helpers";
import { RegistryCredentialService } from "../services/registry-credential";
import type {
  CreateRegistryCredentialRequest,
  UpdateRegistryCredentialRequest,
} from "@mini-infra/types";
import {
  buildRegistryCredentialRequest,
  buildRegistryCredentialUpdateRequest,
} from "./test-data-factories";

describe("RegistryCredentialService", () => {
  let service: RegistryCredentialService;
  const testEncryptionKey = "test-encryption-key-for-testing";
  const testUserId = "test-user-123";

  beforeEach(async () => {
    // Create a fresh service instance for each test
    service = new RegistryCredentialService(testPrisma, testEncryptionKey);
  });

  function buildCredentialRequest(
    overrides: Partial<CreateRegistryCredentialRequest> = {},
  ): CreateRegistryCredentialRequest {
    return buildRegistryCredentialRequest(overrides);
  }

  function buildCredentialUpdate(
    overrides: Partial<UpdateRegistryCredentialRequest> = {},
  ): UpdateRegistryCredentialRequest {
    return buildRegistryCredentialUpdateRequest(overrides);
  }

  describe("Registry URL Extraction", () => {
    test("should extract registry from ghcr.io image", async () => {
      const imageName = "ghcr.io/owner/repo:tag";
      const credentials = await service.getCredentialsForImage(imageName);
      // Should return null since no credentials exist yet
      expect(credentials).toBeNull();
    });

    test("should default to Docker Hub for simple image names", async () => {
      const imageName = "postgres:13";
      const credentials = await service.getCredentialsForImage(imageName);
      expect(credentials).toBeNull();
    });

    test("should extract localhost registry with port", async () => {
      const imageName = "localhost:5000/myimage:latest";
      const credentials = await service.getCredentialsForImage(imageName);
      expect(credentials).toBeNull();
    });
  });

  describe("Create Credential", () => {
    test("should create a new credential with encrypted password", async () => {
      const request: CreateRegistryCredentialRequest = buildCredentialRequest({
        name: "GitHub Container Registry",
        registryUrl: "ghcr.io",
        username: "testuser",
        password: "testpassword123",
        isDefault: false,
        isActive: true,
        description: "Test registry",
      });

      const credential = await service.createCredential(request, testUserId);

      expect(credential).toBeDefined();
      expect(credential.id).toBeDefined();
      expect(credential.name).toBe(request.name);
      expect(credential.registryUrl).toBe(request.registryUrl);
      expect(credential.username).toBe(request.username);
      expect(credential.password).not.toBe(request.password); // Should be encrypted
      expect(credential.createdBy).toBe(testUserId);
      expect(credential.updatedBy).toBe(testUserId);
    });

    test("should set credential as default and unset other defaults", async () => {
      // Create first credential as default
      const first: CreateRegistryCredentialRequest = buildCredentialRequest({
        name: "First Registry",
        registryUrl: "registry1.example.com",
        username: "user1",
        password: "pass1",
        isDefault: true,
      });

      const firstCredential = await service.createCredential(first, testUserId);
      expect(firstCredential.isDefault).toBe(true);

      // Create second credential as default
      const second: CreateRegistryCredentialRequest = buildCredentialRequest({
        name: "Second Registry",
        registryUrl: "registry2.example.com",
        username: "user2",
        password: "pass2",
        isDefault: true,
      });

      const secondCredential = await service.createCredential(
        second,
        testUserId,
      );
      expect(secondCredential.isDefault).toBe(true);

      // First credential should no longer be default
      const updatedFirst = await service.getCredential(firstCredential.id);
      expect(updatedFirst?.isDefault).toBe(false);
    });
  });

  describe("Get Credential", () => {
    test("should retrieve credential by ID", async () => {
      const request: CreateRegistryCredentialRequest = buildCredentialRequest({
        name: "Test Registry",
        registryUrl: "test.example.com",
        username: "testuser",
        password: "testpass",
      });

      const created = await service.createCredential(request, testUserId);
      const retrieved = await service.getCredential(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.name).toBe(request.name);
    });

    test("should return null for non-existent credential", async () => {
      const result = await service.getCredential("non-existent-id");
      expect(result).toBeNull();
    });
  });

  describe("Get All Credentials", () => {
    test("should retrieve all active credentials", async () => {
      await service.createCredential(
        {
          name: "Registry 1",
          registryUrl: "reg1.example.com",
          username: "user1",
          password: "pass1",
          isActive: true,
        },
        testUserId,
      );

      await service.createCredential(
        {
          name: "Registry 2",
          registryUrl: "reg2.example.com",
          username: "user2",
          password: "pass2",
          isActive: true,
        },
        testUserId,
      );

      const credentials = await service.getAllCredentials();
      expect(credentials).toHaveLength(2);
    });

    test("should exclude inactive credentials by default", async () => {
      const active = await service.createCredential(
        {
          name: "Active Registry",
          registryUrl: "active.example.com",
          username: "user",
          password: "pass",
          isActive: true,
        },
        testUserId,
      );

      const inactive = await service.createCredential(
        {
          name: "Inactive Registry",
          registryUrl: "inactive.example.com",
          username: "user",
          password: "pass",
          isActive: false,
        },
        testUserId,
      );

      const activeOnly = await service.getAllCredentials(false);
      expect(activeOnly).toHaveLength(1);
      expect(activeOnly[0].id).toBe(active.id);

      const all = await service.getAllCredentials(true);
      expect(all).toHaveLength(2);
    });

    test("should order credentials with default first", async () => {
      await service.createCredential(
        {
          name: "Non-Default Registry",
          registryUrl: "nondefault.example.com",
          username: "user",
          password: "pass",
          isDefault: false,
        },
        testUserId,
      );

      await service.createCredential(
        {
          name: "Default Registry",
          registryUrl: "default.example.com",
          username: "user",
          password: "pass",
          isDefault: true,
        },
        testUserId,
      );

      const credentials = await service.getAllCredentials();
      expect(credentials[0].isDefault).toBe(true);
    });
  });

  describe("Update Credential", () => {
    test("should update credential fields", async () => {
      const created = await service.createCredential(
        {
          name: "Original Name",
          registryUrl: "registry.example.com",
          username: "original-user",
          password: "original-pass",
        },
        testUserId,
      );

      const updateRequest: UpdateRegistryCredentialRequest = buildCredentialUpdate({
        name: "Updated Name",
        username: "updated-user",
      });

      const updated = await service.updateCredential(
        created.id,
        updateRequest,
        testUserId,
      );

      expect(updated.name).toBe("Updated Name");
      expect(updated.username).toBe("updated-user");
      expect(updated.registryUrl).toBe("registry.example.com"); // Should not change
    });

    test("should encrypt new password when updating", async () => {
      const created = await service.createCredential(
        {
          name: "Test Registry",
          registryUrl: "registry.example.com",
          username: "user",
          password: "original-password",
        },
        testUserId,
      );

      const originalEncryptedPassword = created.password;

      const updated = await service.updateCredential(
        created.id,
        { password: "new-password" },
        testUserId,
      );

      expect(updated.password).not.toBe("new-password");
      expect(updated.password).not.toBe(originalEncryptedPassword);
    });

    test("should handle setting credential as default", async () => {
      const first = await service.createCredential(
        {
          name: "First",
          registryUrl: "first.example.com",
          username: "user",
          password: "pass",
          isDefault: true,
        },
        testUserId,
      );

      const second = await service.createCredential(
        {
          name: "Second",
          registryUrl: "second.example.com",
          username: "user",
          password: "pass",
          isDefault: false,
        },
        testUserId,
      );

      await service.updateCredential(
        second.id,
        { isDefault: true },
        testUserId,
      );

      const updatedFirst = await service.getCredential(first.id);
      const updatedSecond = await service.getCredential(second.id);

      expect(updatedFirst?.isDefault).toBe(false);
      expect(updatedSecond?.isDefault).toBe(true);
    });
  });

  describe("Delete Credential", () => {
    test("should soft delete credential by setting isActive to false", async () => {
      const created = await service.createCredential(
        {
          name: "To Delete",
          registryUrl: "delete.example.com",
          username: "user",
          password: "pass",
        },
        testUserId,
      );

      await service.deleteCredential(created.id);

      const deleted = await service.getCredential(created.id);
      expect(deleted).toBeDefined();
      expect(deleted?.isActive).toBe(false);
    });
  });

  describe("Default Credential Management", () => {
    test("should set credential as default", async () => {
      const credential = await service.createCredential(
        {
          name: "Test Registry",
          registryUrl: "test.example.com",
          username: "user",
          password: "pass",
          isDefault: false,
        },
        testUserId,
      );

      await service.setDefaultCredential(credential.id);

      const updated = await service.getCredential(credential.id);
      expect(updated?.isDefault).toBe(true);
    });

    test("should get default credential", async () => {
      await service.createCredential(
        {
          name: "Non-Default",
          registryUrl: "nondefault.example.com",
          username: "user",
          password: "pass",
          isDefault: false,
        },
        testUserId,
      );

      const defaultCred = await service.createCredential(
        {
          name: "Default",
          registryUrl: "default.example.com",
          username: "user",
          password: "pass",
          isDefault: true,
        },
        testUserId,
      );

      const retrieved = await service.getDefaultCredential();
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(defaultCred.id);
    });

    test("should return null if no default credential exists", async () => {
      const result = await service.getDefaultCredential();
      expect(result).toBeNull();
    });
  });

  describe("Get Credentials For Image", () => {
    test("should return credentials for exact registry match", async () => {
      const credential = await service.createCredential(
        {
          name: "GHCR",
          registryUrl: "ghcr.io",
          username: "testuser",
          password: "testpass",
        },
        testUserId,
      );

      const result = await service.getCredentialsForImage(
        "ghcr.io/owner/repo:tag",
      );

      expect(result).toBeDefined();
      expect(result?.username).toBe("testuser");
      expect(result?.password).toBe("testpass");
    });

    test("should fall back to default credential if no exact match", async () => {
      await service.createCredential(
        {
          name: "Default Registry",
          registryUrl: "registry.hub.docker.com",
          username: "defaultuser",
          password: "defaultpass",
          isDefault: true,
        },
        testUserId,
      );

      const result = await service.getCredentialsForImage(
        "unknownregistry.com/image:tag",
      );

      expect(result).toBeDefined();
      expect(result?.username).toBe("defaultuser");
      expect(result?.password).toBe("defaultpass");
    });

    test("should return null if no credentials match and no default", async () => {
      const result = await service.getCredentialsForImage(
        "someregistry.com/image:tag",
      );

      expect(result).toBeNull();
    });

    test("should handle Docker Hub images correctly", async () => {
      const credential = await service.createCredential(
        {
          name: "Docker Hub",
          registryUrl: "registry.hub.docker.com",
          username: "dockeruser",
          password: "dockerpass",
        },
        testUserId,
      );

      // Test with simple image name (defaults to Docker Hub)
      const result = await service.getCredentialsForImage("postgres:13");

      expect(result).toBeDefined();
      expect(result?.username).toBe("dockeruser");
      expect(result?.password).toBe("dockerpass");
    });

    test("should not return inactive credentials", async () => {
      await service.createCredential(
        {
          name: "Inactive Registry",
          registryUrl: "inactive.example.com",
          username: "user",
          password: "pass",
          isActive: false,
        },
        testUserId,
      );

      const result = await service.getCredentialsForImage(
        "inactive.example.com/image:tag",
      );

      expect(result).toBeNull();
    });
  });

  describe("Password Encryption/Decryption", () => {
    test("should encrypt and decrypt password correctly", async () => {
      const originalPassword = "my-secret-password-123";

      const credential = await service.createCredential(
        {
          name: "Test",
          registryUrl: "test.example.com",
          username: "user",
          password: originalPassword,
        },
        testUserId,
      );

      // Password should be encrypted in database
      expect(credential.password).not.toBe(originalPassword);

      // But when retrieved via getCredentialsForImage, it should be decrypted
      const result = await service.getCredentialsForImage(
        "test.example.com/image:tag",
      );

      expect(result?.password).toBe(originalPassword);
    });
  });
});
