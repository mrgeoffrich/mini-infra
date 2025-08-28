import { describe, it, expect, jest } from "@jest/globals";
import { testPrisma, createTestUser } from "./setup";
import { generateApiKey, hashApiKey } from "../lib/api-key-service";

// Mock logger
jest.mock("../lib/logger.ts", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe("API Key Generation and Validation", () => {
  describe("generateApiKey", () => {
    it("should generate API keys with correct format", () => {
      const key = generateApiKey();

      expect(key).toMatch(/^mk_[a-f0-9]{64}$/);
      expect(key.length).toBe(67); // 'mk_' (3) + 64 hex chars
    });

    it("should generate unique API keys", () => {
      const key1 = generateApiKey();
      const key2 = generateApiKey();
      const key3 = generateApiKey();

      expect(key1).not.toBe(key2);
      expect(key2).not.toBe(key3);
      expect(key1).not.toBe(key3);
    });

    it("should always start with mk_ prefix", () => {
      for (let i = 0; i < 10; i++) {
        const key = generateApiKey();
        expect(key).toMatch(/^mk_/);
      }
    });
  });

  describe("hashApiKey", () => {
    it("should generate consistent hashes for the same key", () => {
      const key = "mk_test123456789";
      const hash1 = hashApiKey(key);
      const hash2 = hashApiKey(key);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA256 hex output
    });

    it("should generate different hashes for different keys", () => {
      const key1 = "mk_test123456789";
      const key2 = "mk_test987654321";

      const hash1 = hashApiKey(key1);
      const hash2 = hashApiKey(key2);

      expect(hash1).not.toBe(hash2);
    });

    it("should handle environment secret correctly", () => {
      const originalSecret = process.env.API_KEY_SECRET;

      // Test with custom secret
      process.env.API_KEY_SECRET = "test-secret-123";
      const key = "mk_test123456789";
      const hash1 = hashApiKey(key);

      // Change secret and verify hash changes
      process.env.API_KEY_SECRET = "different-secret-456";
      const hash2 = hashApiKey(key);

      expect(hash1).not.toBe(hash2);

      // Restore original secret
      process.env.API_KEY_SECRET = originalSecret;
    });
  });

  describe("API Key Database Operations", () => {
    it("should create API key with proper data structure", async () => {
      const testUser = await createTestUser();
      const rawKey = generateApiKey();
      const hashedKey = hashApiKey(rawKey);

      const apiKey = await testPrisma.apiKey.create({
        data: {
          name: "Test API Key",
          key: hashedKey,
          userId: testUser.id,
          active: true,
        },
      });

      expect(apiKey.name).toBe("Test API Key");
      expect(apiKey.userId).toBe(testUser.id);
      expect(apiKey.active).toBe(true);
      expect(apiKey.key).toBe(hashedKey);
      expect(apiKey.key).not.toBe(rawKey); // Should be hashed
      expect(apiKey.id).toBeTruthy();
      expect(apiKey.createdAt).toBeInstanceOf(Date);
      expect(apiKey.lastUsedAt).toBeNull();
    });

    it("should enforce unique key constraint", async () => {
      const testUser = await createTestUser();
      const rawKey = generateApiKey();
      const hashedKey = hashApiKey(rawKey);

      // Create first API key
      await testPrisma.apiKey.create({
        data: {
          name: "First Key",
          key: hashedKey,
          userId: testUser.id,
          active: true,
        },
      });

      // Attempt to create duplicate key should fail
      await expect(
        testPrisma.apiKey.create({
          data: {
            name: "Duplicate Key",
            key: hashedKey, // Same hash
            userId: testUser.id,
            active: true,
          },
        }),
      ).rejects.toThrow();
    });

    it("should retrieve API keys for a user", async () => {
      const testUser = await createTestUser();

      // Create multiple API keys
      const key1 = generateApiKey();
      const key2 = generateApiKey();

      await testPrisma.apiKey.create({
        data: {
          name: "Key 1",
          key: hashApiKey(key1),
          userId: testUser.id,
          active: true,
        },
      });

      await testPrisma.apiKey.create({
        data: {
          name: "Key 2",
          key: hashApiKey(key2),
          userId: testUser.id,
          active: false,
        },
      });

      // Retrieve all keys for user
      const allKeys = await testPrisma.apiKey.findMany({
        where: { userId: testUser.id },
        orderBy: { createdAt: "desc" },
      });

      expect(allKeys.length).toBe(2);
      expect(allKeys[0].name).toBe("Key 2"); // Most recent first
      expect(allKeys[1].name).toBe("Key 1");

      // Retrieve only active keys
      const activeKeys = await testPrisma.apiKey.findMany({
        where: { userId: testUser.id, active: true },
      });

      expect(activeKeys.length).toBe(1);
      expect(activeKeys[0].name).toBe("Key 1");
    });

    it("should update API key properties", async () => {
      const testUser = await createTestUser();
      const rawKey = generateApiKey();

      const apiKey = await testPrisma.apiKey.create({
        data: {
          name: "Original Name",
          key: hashApiKey(rawKey),
          userId: testUser.id,
          active: true,
        },
      });

      // Update active status
      const updatedKey = await testPrisma.apiKey.update({
        where: { id: apiKey.id },
        data: { active: false },
      });

      expect(updatedKey.active).toBe(false);
      expect(updatedKey.name).toBe("Original Name"); // Unchanged

      // Update lastUsedAt
      const now = new Date();
      await testPrisma.apiKey.update({
        where: { id: apiKey.id },
        data: { lastUsedAt: now },
      });

      const keyWithUsage = await testPrisma.apiKey.findUnique({
        where: { id: apiKey.id },
      });

      expect(keyWithUsage?.lastUsedAt).toEqual(now);
    });

    it("should delete API keys", async () => {
      const testUser = await createTestUser();
      const rawKey = generateApiKey();

      const apiKey = await testPrisma.apiKey.create({
        data: {
          name: "Delete Me",
          key: hashApiKey(rawKey),
          userId: testUser.id,
          active: true,
        },
      });

      // Verify key exists
      const foundKey = await testPrisma.apiKey.findUnique({
        where: { id: apiKey.id },
      });
      expect(foundKey).toBeTruthy();

      // Delete key
      await testPrisma.apiKey.delete({
        where: { id: apiKey.id },
      });

      // Verify key is deleted
      const deletedKey = await testPrisma.apiKey.findUnique({
        where: { id: apiKey.id },
      });
      expect(deletedKey).toBeNull();
    });

    it("should count API keys by status", async () => {
      const testUser = await createTestUser();

      // Create active keys
      await testPrisma.apiKey.create({
        data: {
          name: "Active 1",
          key: hashApiKey(generateApiKey()),
          userId: testUser.id,
          active: true,
        },
      });

      await testPrisma.apiKey.create({
        data: {
          name: "Active 2",
          key: hashApiKey(generateApiKey()),
          userId: testUser.id,
          active: true,
        },
      });

      // Create inactive key
      await testPrisma.apiKey.create({
        data: {
          name: "Inactive 1",
          key: hashApiKey(generateApiKey()),
          userId: testUser.id,
          active: false,
        },
      });

      const totalCount = await testPrisma.apiKey.count({
        where: { userId: testUser.id },
      });

      const activeCount = await testPrisma.apiKey.count({
        where: { userId: testUser.id, active: true },
      });

      const inactiveCount = await testPrisma.apiKey.count({
        where: { userId: testUser.id, active: false },
      });

      expect(totalCount).toBe(3);
      expect(activeCount).toBe(2);
      expect(inactiveCount).toBe(1);
    });

    it("should handle cascade delete when user is deleted", async () => {
      const testUser = await createTestUser();

      // Create API key
      await testPrisma.apiKey.create({
        data: {
          name: "Cascade Test",
          key: hashApiKey(generateApiKey()),
          userId: testUser.id,
          active: true,
        },
      });

      // Verify key exists
      const keysBeforeDelete = await testPrisma.apiKey.findMany({
        where: { userId: testUser.id },
      });
      expect(keysBeforeDelete.length).toBe(1);

      // Delete user (should cascade to API keys)
      await testPrisma.user.delete({
        where: { id: testUser.id },
      });

      // Verify API keys are deleted
      const keysAfterDelete = await testPrisma.apiKey.findMany({
        where: { userId: testUser.id },
      });
      expect(keysAfterDelete.length).toBe(0);
    });
  });

  describe("API Key Validation Logic", () => {
    it("should validate key lookup by hash", async () => {
      const testUser = await createTestUser();
      const rawKey = generateApiKey();
      const hashedKey = hashApiKey(rawKey);

      // Create API key
      const apiKey = await testPrisma.apiKey.create({
        data: {
          name: "Validation Test",
          key: hashedKey,
          userId: testUser.id,
          active: true,
        },
        include: {
          user: true,
        },
      });

      // Simulate validation: look up by hashed key
      const foundKey = await testPrisma.apiKey.findUnique({
        where: { key: hashApiKey(rawKey) },
        include: { user: true },
      });

      expect(foundKey).toBeTruthy();
      expect(foundKey?.id).toBe(apiKey.id);
      expect(foundKey?.active).toBe(true);
      expect(foundKey?.user.id).toBe(testUser.id);
      expect(foundKey?.user.email).toBe(testUser.email);
    });

    it("should reject validation for inactive keys", async () => {
      const testUser = await createTestUser();
      const rawKey = generateApiKey();

      // Create inactive API key
      await testPrisma.apiKey.create({
        data: {
          name: "Inactive Key",
          key: hashApiKey(rawKey),
          userId: testUser.id,
          active: false,
        },
      });

      // Simulate validation
      const foundKey = await testPrisma.apiKey.findUnique({
        where: { key: hashApiKey(rawKey) },
      });

      expect(foundKey?.active).toBe(false);
    });

    it("should reject validation for non-existent keys", async () => {
      const nonExistentKey = generateApiKey();

      const foundKey = await testPrisma.apiKey.findUnique({
        where: { key: hashApiKey(nonExistentKey) },
      });

      expect(foundKey).toBeNull();
    });

    it("should track usage with lastUsedAt updates", async () => {
      const testUser = await createTestUser();
      const rawKey = generateApiKey();

      const apiKey = await testPrisma.apiKey.create({
        data: {
          name: "Usage Tracking",
          key: hashApiKey(rawKey),
          userId: testUser.id,
          active: true,
        },
      });

      // Initial lastUsedAt should be null
      expect(apiKey.lastUsedAt).toBeNull();

      // Simulate successful validation (update lastUsedAt)
      const validatedKey = await testPrisma.apiKey.update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() },
      });

      expect(validatedKey.lastUsedAt).toBeInstanceOf(Date);
      expect(validatedKey.lastUsedAt!.getTime()).toBeGreaterThan(
        Date.now() - 5000,
      );
    });
  });

  describe("API Key Security Properties", () => {
    it("should use secure key format", () => {
      const keys = Array.from({ length: 100 }, () => generateApiKey());

      keys.forEach((key) => {
        // Should have proper format
        expect(key).toMatch(/^mk_[a-f0-9]{64}$/);

        // Should have proper length
        expect(key.length).toBe(67);
      });

      // All keys should be unique
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });

    it("should use secure hashing", () => {
      const key1 = "mk_test1234567890abcdef";
      const key2 = "mk_test1234567890abcdeg"; // Only last char different

      const hash1 = hashApiKey(key1);
      const hash2 = hashApiKey(key2);

      // Small change in input should produce completely different hash
      expect(hash1).not.toBe(hash2);

      // Hashes should be proper SHA256 format
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
      expect(hash2).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should maintain hash consistency across environment changes", () => {
      const key = "mk_consistency_test_key_12345";

      // Set specific secret
      const originalSecret = process.env.API_KEY_SECRET;
      process.env.API_KEY_SECRET = "consistent-secret-123";

      const hash1 = hashApiKey(key);
      const hash2 = hashApiKey(key);
      const hash3 = hashApiKey(key);

      // All hashes should be identical
      expect(hash1).toBe(hash2);
      expect(hash2).toBe(hash3);

      // Restore original secret
      process.env.API_KEY_SECRET = originalSecret;
    });

    it("should isolate users API keys", async () => {
      const user1 = await createTestUser();
      const user2 = await createTestUser();

      // Create keys for both users
      await testPrisma.apiKey.create({
        data: {
          name: "User 1 Key",
          key: hashApiKey(generateApiKey()),
          userId: user1.id,
          active: true,
        },
      });

      await testPrisma.apiKey.create({
        data: {
          name: "User 2 Key",
          key: hashApiKey(generateApiKey()),
          userId: user2.id,
          active: true,
        },
      });

      // User 1 should only see their keys
      const user1Keys = await testPrisma.apiKey.findMany({
        where: { userId: user1.id },
      });

      expect(user1Keys.length).toBe(1);
      expect(user1Keys[0].name).toBe("User 1 Key");

      // User 2 should only see their keys
      const user2Keys = await testPrisma.apiKey.findMany({
        where: { userId: user2.id },
      });

      expect(user2Keys.length).toBe(1);
      expect(user2Keys[0].name).toBe("User 2 Key");
    });
  });
});
