import { testPrisma, createTestUser } from "./integration-test-helpers";

describe("Test Environment Setup", () => {
  it("should connect to test database", async () => {
    const result = await testPrisma.$queryRaw`SELECT 1 as test`;
    expect(result).toEqual([{ test: 1n }]); // SQLite returns BigInt
  });

  it("should create unique test users", async () => {
    const user1 = await createTestUser();
    const user2 = await createTestUser();

    expect(user1.id).not.toBe(user2.id);
    expect(user1.email).not.toBe(user2.email);
    expect(user1.googleId).not.toBe(user2.googleId);
  });
});
