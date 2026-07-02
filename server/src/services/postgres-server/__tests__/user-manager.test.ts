import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "pg";

const findFirst = vi.fn();
const create = vi.fn();
const update = vi.fn();

vi.mock("../../../lib/prisma", () => ({
  default: {
    managedDatabaseUser: {
      findFirst: (...args: unknown[]) => findFirst(...args),
      create: (...args: unknown[]) => create(...args),
      update: (...args: unknown[]) => update(...args),
    },
  },
}));

const getClient = vi.fn();
const getServer = vi.fn();

vi.mock("../server-manager", () => ({
  default: {
    getClient: (...args: unknown[]) => getClient(...args),
    getServer: (...args: unknown[]) => getServer(...args),
  },
}));

import userManagementService from "../user-manager";

/**
 * Builds a fake pg client for query/end assertions while keeping the real
 * `escapeLiteral()` from the pg prototype (pure string logic, no connection
 * needed) so tests exercise the actual escaping behavior.
 */
function makeFakeClient(queryImpl: (sql: string, params?: unknown[]) => unknown) {
  const client = Object.create(Client.prototype) as Client;
  client.query = vi.fn(queryImpl) as unknown as Client["query"];
  client.end = vi.fn().mockResolvedValue(undefined) as unknown as Client["end"];
  return client;
}

describe("UserManagementService password handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("createUser embeds the password as an escaped SQL literal, not a bind parameter", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = makeFakeClient((sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [] };
    });
    getClient.mockResolvedValue(client);
    create.mockResolvedValue({ id: "u1", username: "app_user" });

    await userManagementService.createUser("server-1", "user-1", {
      username: "app_user",
      password: "p@ss'word",
    });

    expect(queries).toHaveLength(2);
    const [createStatement, alterStatement] = queries;

    expect(createStatement.sql).toContain('CREATE USER "app_user"');
    expect(createStatement.params).toBeUndefined();

    // The password must be inlined as an escaped literal — PostgreSQL's
    // ALTER/CREATE USER PASSWORD clause does not accept a $1 bind parameter.
    expect(alterStatement.params).toBeUndefined();
    expect(alterStatement.sql).not.toContain("$1");
    expect(alterStatement.sql).toContain(`ALTER USER "app_user" WITH PASSWORD`);
    // Embedded single quote in the password must be doubled, not left raw.
    expect(alterStatement.sql).toContain("p@ss''word");

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ username: "app_user" }),
      })
    );
  });

  it("changePassword embeds the new password as an escaped SQL literal, not a bind parameter", async () => {
    getServer.mockResolvedValue({ id: "server-1" });
    findFirst.mockResolvedValue({ id: "mu-1", username: "app_user" });
    update.mockResolvedValue({});

    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = makeFakeClient((sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [] };
    });
    getClient.mockResolvedValue(client);

    await userManagementService.changePassword("server-1", "user-1", "mu-1", "new'pass");

    expect(queries).toHaveLength(1);
    expect(queries[0].params).toBeUndefined();
    expect(queries[0].sql).not.toContain("$1");
    expect(queries[0].sql).toContain(`ALTER USER "app_user" WITH PASSWORD`);
    expect(queries[0].sql).toContain("new''pass");
  });

  it("createUser surfaces a clear error and still closes the client if the ALTER statement fails", async () => {
    const client = makeFakeClient((sql: string) => {
      if (sql.startsWith("CREATE USER")) return { rows: [] };
      throw new Error('syntax error at or near "$1"');
    });
    getClient.mockResolvedValue(client);

    await expect(
      userManagementService.createUser("server-1", "user-1", {
        username: "app_user",
        password: "hunter2",
      })
    ).rejects.toThrow('syntax error at or near "$1"');

    expect(client.end).toHaveBeenCalled();
    // The managed-user DB record should never be created if the server-side
    // password statement failed.
    expect(create).not.toHaveBeenCalled();
  });
});
