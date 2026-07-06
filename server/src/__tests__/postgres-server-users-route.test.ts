import request from "supertest";
import express from "express";

// ---------------------------------------------------------------------------
// Hoisted mocks — declared before any vi.mock() calls that reference them.
// ---------------------------------------------------------------------------
const { mockChangePassword, mockLogger, mockRequirePermission } = vi.hoisted(
  () => ({
    mockChangePassword: vi.fn().mockResolvedValue(undefined),
    mockLogger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    mockRequirePermission: vi.fn(
      () => (_req: any, _res: any, next: any) => next(),
    ),
  }),
);

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock("../lib/logger-factory", () => ({
  getLogger: vi.fn(() => mockLogger),
  clearLoggerCache: vi.fn(),
}));

vi.mock("../middleware/auth", () => ({
  requirePermission: mockRequirePermission,
  getCurrentUserId: () => "test-user-id",
}));

vi.mock("../services/postgres-server/user-manager", () => ({
  default: {
    changePassword: mockChangePassword,
  },
}));

vi.mock("../services/postgres-server/grant-manager", () => ({
  default: {
    listGrantsForUser: vi.fn(),
  },
}));

// Import the router AFTER the mocks are set up.
import usersRouter from "../routes/postgres-server/users";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------
const SERVER_ID = "server-123";
const USER_ID = "user-456";
const PASSWORD_PATH = `/api/postgres-server/servers/${SERVER_ID}/users/${USER_ID}/password`;

describe("Postgres-server user password route", () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    // mergeParams:true on the router exposes :serverId to the handlers.
    app.use("/api/postgres-server/servers/:serverId/users", usersRouter);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts POST to change a user's password (regression: client must not send PUT)", async () => {
    const res = await request(app)
      .post(PASSWORD_PATH)
      .send({ password: "new-secret-123" });

    // The client previously sent PUT, which hit no registered route (404).
    // The registered method is POST — it must reach the handler and succeed.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(mockChangePassword).toHaveBeenCalledTimes(1);
    expect(mockChangePassword).toHaveBeenCalledWith(
      SERVER_ID,
      "test-user-id",
      USER_ID,
      "new-secret-123",
    );
  });

  it("does not register PUT on the password route (the original client bug 404'd)", async () => {
    const res = await request(app)
      .put(PASSWORD_PATH)
      .send({ password: "new-secret-123" });

    expect(res.status).toBe(404);
    expect(mockChangePassword).not.toHaveBeenCalled();
  });

  it("validates that a password is supplied (POST with empty body → 400)", async () => {
    const res = await request(app).post(PASSWORD_PATH).send({});

    expect(res.status).toBe(400);
    expect(mockChangePassword).not.toHaveBeenCalled();
  });
});
