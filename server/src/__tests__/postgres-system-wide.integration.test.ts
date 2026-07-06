import { createId } from "@paralleldrive/cuid2";
import { testPrisma } from "./integration-test-helpers";
import { PostgresDatabaseManager } from "../services/postgres";
import { CreatePostgresDatabaseRequest } from "@mini-infra/types";
import { buildPostgresDatabaseRequest } from "./test-data-factories";

describe("PostgreSQL System-Wide Database Management", () => {
  let databaseConfigService: PostgresDatabaseManager;
  let environmentId: string;

  beforeAll(() => {
    databaseConfigService = new PostgresDatabaseManager(testPrisma);
  });

  beforeEach(async () => {
    // The integration suite truncates the DB after every test (see
    // setup-integration.ts's global afterEach) — re-seed per test.
    const environment = await testPrisma.environment.create({
      data: {
        name: `env-${createId().slice(0, 8)}`,
        type: "nonproduction",
        networkType: "local",
      },
    });
    environmentId = environment.id;
  });

  describe("Database Creation", () => {
    it("should create a database without requiring userId", async () => {
      const createRequest: CreatePostgresDatabaseRequest = buildPostgresDatabaseRequest(environmentId, {
        name: "test-database",
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        password: "testpass",
        sslMode: "prefer",
        tags: ["test"],
      });

      const createdDatabase = await databaseConfigService.createDatabase(createRequest);

      expect(createdDatabase).toBeDefined();
      expect(createdDatabase.name).toBe("test-database");
      expect(createdDatabase.host).toBe("localhost");
      expect(createdDatabase.port).toBe(5432);
      expect(createdDatabase.tags).toEqual(["test"]);
      expect(createdDatabase.connectionString).toBe("[REDACTED]");
      expect(createdDatabase.environmentId).toBe(environmentId);
    });

    it("should enforce system-wide unique database names", async () => {
      const createRequest: CreatePostgresDatabaseRequest = buildPostgresDatabaseRequest(environmentId, {
        name: "unique-database",
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        password: "testpass",
        sslMode: "prefer",
      });

      // Create first database
      await databaseConfigService.createDatabase(createRequest);

      // Attempt to create second database with same name should fail
      await expect(
        databaseConfigService.createDatabase(createRequest)
      ).rejects.toThrow("Database configuration with name 'unique-database' already exists");
    });

    it("should reject an environmentId that doesn't exist", async () => {
      const createRequest: CreatePostgresDatabaseRequest = buildPostgresDatabaseRequest("nonexistent-env-id", {
        name: "orphan-database",
      });

      await expect(
        databaseConfigService.createDatabase(createRequest)
      ).rejects.toThrow("Environment 'nonexistent-env-id' not found");
    });
  });

  describe("Database Retrieval", () => {
    it("should retrieve database by ID without userId filter", async () => {
      const createRequest: CreatePostgresDatabaseRequest = buildPostgresDatabaseRequest(environmentId, {
        name: "retrievable-database",
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        password: "testpass",
        sslMode: "prefer",
      });

      const createdDatabase = await databaseConfigService.createDatabase(createRequest);

      const retrievedDatabase = await databaseConfigService.getDatabaseById(createdDatabase.id);

      expect(retrievedDatabase).toBeDefined();
      expect(retrievedDatabase?.name).toBe("retrievable-database");
      expect(retrievedDatabase?.id).toBe(createdDatabase.id);
    });

    it("should list all databases system-wide", async () => {
      // Create multiple databases
      const databases = [
        buildPostgresDatabaseRequest(environmentId, {
          name: "database-1",
          host: "host1.example.com",
          port: 5432,
          database: "db1",
          username: "user1",
          password: "pass1",
          sslMode: "prefer" as const,
        }),
        buildPostgresDatabaseRequest(environmentId, {
          name: "database-2",
          host: "host2.example.com",
          port: 5433,
          database: "db2",
          username: "user2",
          password: "pass2",
          sslMode: "require" as const,
        }),
      ];

      for (const dbConfig of databases) {
        await databaseConfigService.createDatabase(dbConfig);
      }

      const allDatabases = await databaseConfigService.listDatabases();

      expect(allDatabases).toHaveLength(2);
      expect(allDatabases.map(db => db.name)).toContain("database-1");
      expect(allDatabases.map(db => db.name)).toContain("database-2");
    });
  });

  describe("Database Updates", () => {
    it("should update database without userId parameter", async () => {
      const createRequest: CreatePostgresDatabaseRequest = buildPostgresDatabaseRequest(environmentId, {
        name: "updatable-database",
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        password: "testpass",
        sslMode: "prefer",
      });

      const createdDatabase = await databaseConfigService.createDatabase(createRequest);

      const updateRequest = {
        name: "updated-database",
        host: "newhost.example.com",
        port: 5433,
      };

      const updatedDatabase = await databaseConfigService.updateDatabase(
        createdDatabase.id,
        updateRequest
      );

      expect(updatedDatabase.name).toBe("updated-database");
      expect(updatedDatabase.host).toBe("newhost.example.com");
      expect(updatedDatabase.port).toBe(5433);
    });

    it("should rebuild connection string preserving password when only host/port changes", async () => {
      const createdDatabase = await databaseConfigService.createDatabase(
        buildPostgresDatabaseRequest(environmentId, {
          name: "partial-update-db",
          host: "oldhost.example.com",
          port: 5432,
          database: "origdb",
          username: "originaluser",
          password: "original-secret-pw",
          sslMode: "prefer",
        }),
      );

      await databaseConfigService.updateDatabase(createdDatabase.id, {
        host: "newhost.example.com",
        port: 5433,
      });

      // Inspect the stored row directly — the public API redacts connectionString.
      const stored = await testPrisma.postgresDatabase.findUnique({
        where: { id: createdDatabase.id },
      });

      expect(stored).not.toBeNull();
      expect(stored!.connectionString).toBe(
        "postgresql://originaluser:original-secret-pw@newhost.example.com:5433/origdb?sslmode=prefer",
      );
      expect(stored!.host).toBe("newhost.example.com");
      expect(stored!.port).toBe(5433);
      expect(stored!.username).toBe("originaluser");
    });

    it("should rebuild connection string when password changes", async () => {
      const createdDatabase = await databaseConfigService.createDatabase(
        buildPostgresDatabaseRequest(environmentId, {
          name: "password-update-db",
          host: "host.example.com",
          port: 5432,
          database: "mydb",
          username: "myuser",
          password: "old-pw",
          sslMode: "require",
        }),
      );

      await databaseConfigService.updateDatabase(createdDatabase.id, {
        password: "new-pw",
      });

      const stored = await testPrisma.postgresDatabase.findUnique({
        where: { id: createdDatabase.id },
      });

      expect(stored!.connectionString).toBe(
        "postgresql://myuser:new-pw@host.example.com:5432/mydb?sslmode=require",
      );
    });

    it("should update and clear environmentId", async () => {
      const otherEnvironment = await testPrisma.environment.create({
        data: {
          name: `env-${createId().slice(0, 8)}`,
          type: "nonproduction",
          networkType: "local",
        },
      });

      const createdDatabase = await databaseConfigService.createDatabase(
        buildPostgresDatabaseRequest(environmentId, { name: "env-reassign-db" }),
      );

      const reassigned = await databaseConfigService.updateDatabase(createdDatabase.id, {
        environmentId: otherEnvironment.id,
      });
      expect(reassigned.environmentId).toBe(otherEnvironment.id);

      const cleared = await databaseConfigService.updateDatabase(createdDatabase.id, {
        environmentId: null,
      });
      expect(cleared.environmentId).toBeNull();
    });

    it("should reject updating to an environmentId that doesn't exist", async () => {
      const createdDatabase = await databaseConfigService.createDatabase(
        buildPostgresDatabaseRequest(environmentId, { name: "env-update-reject-db" }),
      );

      await expect(
        databaseConfigService.updateDatabase(createdDatabase.id, {
          environmentId: "nonexistent-env-id",
        }),
      ).rejects.toThrow("Environment 'nonexistent-env-id' not found");
    });
  });

  describe("Database Deletion", () => {
    it("should delete database without userId parameter", async () => {
      const createRequest: CreatePostgresDatabaseRequest = buildPostgresDatabaseRequest(environmentId, {
        name: "deletable-database",
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        password: "testpass",
        sslMode: "prefer",
      });

      const createdDatabase = await databaseConfigService.createDatabase(createRequest);

      await databaseConfigService.deleteDatabase(createdDatabase.id);

      const retrievedDatabase = await databaseConfigService.getDatabaseById(createdDatabase.id);
      expect(retrievedDatabase).toBeNull();
    });
  });
});
