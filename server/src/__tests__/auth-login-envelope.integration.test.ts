/**
 * HTTP-level reference test for Phase 9 of the error-handling overhaul
 * (docs/planning/not-shipped/error-handling-overhaul-plan.md) — the auth
 * domain's canonical failure (invalid login credentials) must come back
 * through the standard envelope with a populated `message`, not the legacy
 * `{ error: "<human text>" }` shape `/auth/login` used to hand-roll (which
 * left `message` empty and forced the client to read the human text out of
 * `.error`/`.code` instead).
 */
import supertest from "supertest";
import type { Application } from "express";
import { testPrisma, createTestUser } from "./integration-test-helpers";
import { hashPassword } from "../lib/password-service";

// Route through the real Prisma-backed test database instead of the
// production singleton (same pattern as postgres-backup-quick-setup-conflict).
vi.mock("../lib/prisma", () => ({ default: testPrisma }));

import { createApp } from "../app-factory";

describe("POST /auth/login — standard envelope on invalid credentials", () => {
  let app: Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp({ quiet: true });
  });

  it("returns 401 AUTH_INVALID_CREDENTIALS with a populated message for a wrong password", async () => {
    const user = await createTestUser();
    await testPrisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword("correct-horse-battery-staple1"),
        authMethod: "local",
      },
    });

    const response = await supertest(app)
      .post("/auth/login")
      .send({ email: user.email, password: "totally-wrong-password" })
      .expect(401);

    // The legacy shape was `{ error: "Invalid credentials" }` with NO
    // `message` field at all — assert both fields are present and distinct:
    // `error` is the stable machine code, `message` is the human text.
    expect(response.body).toMatchObject({
      error: "AUTH_INVALID_CREDENTIALS",
      message: expect.any(String),
    });
    expect(response.body.message.length).toBeGreaterThan(0);
    expect(response.body.requestId).toEqual(expect.any(String));
    expect(response.body.timestamp).toEqual(expect.any(String));
  });

  it("returns the same envelope shape for an unknown email", async () => {
    const response = await supertest(app)
      .post("/auth/login")
      .send({ email: "no-such-user@example.com", password: "whatever1" })
      .expect(401);

    expect(response.body).toMatchObject({
      error: "AUTH_INVALID_CREDENTIALS",
      message: expect.any(String),
    });
  });
});
