import { parseSqliteDatabaseUrl, getDatabaseFilePath } from "../lib/database-url-parser";
import path from "path";

describe("parseSqliteDatabaseUrl", () => {
  const schemaDir = "/app/server/prisma"; // Mimics Prisma's behavior: resolves relative to schema.prisma directory

  describe("Valid URLs", () => {
    it("should parse simple relative path", () => {
      const url = "file:./dev.db";
      const result = parseSqliteDatabaseUrl(url, schemaDir);
      expect(result).toBe(path.resolve(schemaDir, "./dev.db"));
    });

    it("should parse relative path with directory", () => {
      const url = "file:./data/dev.db";
      const result = parseSqliteDatabaseUrl(url, schemaDir);
      expect(result).toBe(path.resolve(schemaDir, "./data/dev.db"));
    });

    it("should parse path with query parameters", () => {
      const url = "file:./dev.db?connection_limit=1";
      const result = parseSqliteDatabaseUrl(url, schemaDir);
      expect(result).toBe(path.resolve(schemaDir, "./dev.db"));
    });

    it("should parse path with multiple query parameters", () => {
      const url = "file:./dev.db?connection_limit=1&timeout=5000";
      const result = parseSqliteDatabaseUrl(url, schemaDir);
      expect(result).toBe(path.resolve(schemaDir, "./dev.db"));
    });

    it("should parse path starting with prisma/", () => {
      const url = "file:./prisma/dev.db";
      const result = parseSqliteDatabaseUrl(url, schemaDir);
      expect(result).toBe(path.resolve(schemaDir, "./prisma/dev.db"));
    });

    it("should parse parent directory path", () => {
      const url = "file:../data/dev.db";
      const result = parseSqliteDatabaseUrl(url, schemaDir);
      expect(result).toBe(path.resolve(schemaDir, "../data/dev.db"));
    });

    it("should handle path without leading dot", () => {
      const url = "file:data/dev.db";
      const result = parseSqliteDatabaseUrl(url, schemaDir);
      expect(result).toBe(path.resolve(schemaDir, "data/dev.db"));
    });

    // Unix absolute path test - only meaningful on Unix systems
    if (process.platform !== "win32") {
      it("should parse absolute path on Unix", () => {
        const url = "file:/var/lib/database/dev.db";
        const result = parseSqliteDatabaseUrl(url, schemaDir);
        expect(result).toBe("/var/lib/database/dev.db");
      });

      it("should parse absolute path with query parameters on Unix", () => {
        const url = "file:/var/lib/database/dev.db?connection_limit=1";
        const result = parseSqliteDatabaseUrl(url, schemaDir);
        expect(result).toBe("/var/lib/database/dev.db");
      });
    }
  });

  describe("Error Cases", () => {
    it("should throw error if DATABASE_URL is undefined", () => {
      expect(() => parseSqliteDatabaseUrl(undefined)).toThrow(
        "DATABASE_URL environment variable is not set"
      );
    });

    it("should throw error if URL does not start with file:", () => {
      const url = "postgresql://localhost:5432/mydb";
      expect(() => parseSqliteDatabaseUrl(url, schemaDir)).toThrow(
        "DATABASE_URL must use file: protocol for SQLite"
      );
    });

    it("should throw error for empty string", () => {
      expect(() => parseSqliteDatabaseUrl("", schemaDir)).toThrow(
        "DATABASE_URL environment variable is not set"
      );
    });
  });

  describe("getDatabaseFilePath", () => {
    const originalEnv = process.env.DATABASE_URL;
    const prismaDir = path.join(process.cwd(), "prisma");

    afterEach(() => {
      // Restore original DATABASE_URL
      if (originalEnv) {
        process.env.DATABASE_URL = originalEnv;
      } else {
        delete process.env.DATABASE_URL;
      }
    });

    it("should use process.env.DATABASE_URL and resolve relative to prisma/ directory", () => {
      process.env.DATABASE_URL = "file:./test.db";
      const result = getDatabaseFilePath();
      expect(result).toBe(path.resolve(prismaDir, "./test.db"));
    });

    it("should handle query parameters from environment", () => {
      process.env.DATABASE_URL = "file:./test.db?connection_limit=1";
      const result = getDatabaseFilePath();
      expect(result).toBe(path.resolve(prismaDir, "./test.db"));
    });

    it("should throw if DATABASE_URL is not set", () => {
      delete process.env.DATABASE_URL;
      expect(() => getDatabaseFilePath()).toThrow(
        "DATABASE_URL environment variable is not set"
      );
    });
  });
});
