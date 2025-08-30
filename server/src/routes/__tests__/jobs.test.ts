import { jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { createId } from "@paralleldrive/cuid2";
import {
  JobStatus,
  CreateJobRequest,
  JobResponse,
  JobListResponse,
  ApiResponse,
  ValidationError,
} from "@mini-infra/types";

// Mock Prisma client
const mockPrisma = {
  job: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  jobExecution: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  jobLog: {
    findMany: jest.fn(),
    create: jest.fn(),
  },
};

jest.mock("../../lib/prisma", () => mockPrisma);

// Mock logger
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

jest.mock("../../lib/logger", () => mockLogger);

// Mock auth middleware
const mockRequireJwt = jest.fn((req: any, res: any, next: any) => {
  req.user = { id: "test-user-id", email: "test@example.com" };
  next();
});

const mockGetAuthenticatedUser = jest.fn(() => ({
  id: "test-user-id",
  email: "test@example.com",
}));

jest.mock("../../lib/auth-middleware", () => ({
  authMiddleware: {
    requireJwt: mockRequireJwt,
  },
  getAuthenticatedUser: mockGetAuthenticatedUser,
}));

// Mock job queue service
const mockJobQueueService = {
  addJob: jest.fn(),
  getJobStatus: jest.fn(),
};

jest.mock("../../services/job-queue", () => ({
  jobQueueService: mockJobQueueService,
}));

// Mock SSE service
const mockSseService = {
  connect: jest.fn(),
  disconnect: jest.fn(),
  broadcast: jest.fn(),
};

jest.mock("../../services/sse", () => ({
  sseService: mockSseService,
}));

// Mock job service
const mockJobService = {
  createJob: jest.fn(),
  updateJob: jest.fn(),
  getJob: jest.fn(),
  listJobs: jest.fn(),
};

jest.mock("../../services/job-service", () => ({
  JobService: jest.fn().mockImplementation(() => mockJobService),
}));

// Mock uuid
jest.mock("uuid", () => ({
  v4: () => "mock-session-id-12345",
}));

import jobsRouter from "../jobs";

describe("Jobs API Routes", () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());

    // Add request ID middleware for testing
    app.use((req: any, res: any, next: any) => {
      req.headers["x-request-id"] = req.headers["x-request-id"] || createId();
      req.get = jest.fn((header: string) => {
        if (header === "User-Agent") return "Test Agent";
        return undefined;
      });
      next();
    });

    app.use("/api/jobs", jobsRouter);

    // Add error handler for testing
    app.use((error: any, req: any, res: any, next: any) => {
      res.status(500).json({
        error: "Internal Server Error",
        message: error.message || "An unexpected error occurred",
        timestamp: new Date().toISOString(),
        requestId: req.headers["x-request-id"],
      });
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Set up default mock returns
    mockGetAuthenticatedUser.mockReturnValue({
      id: "test-user-id",
      email: "test@example.com",
    });

    mockRequireJwt.mockImplementation((req: any, res: any, next: any) => {
      req.user = { id: "test-user-id", email: "test@example.com" };
      next();
    });
  });

  describe("POST /api/jobs - Create Job", () => {
    const validCreateRequest: CreateJobRequest = {
      repositoryUrl: "https://github.com/test/repo",
      githubToken: "ghp_test_token_12345",
      storyFile: "stories/user-story.md",
      architectureDoc: "docs/architecture.md",
      branchPrefix: "feature",
      featureBranch: "main",
      customPrompt: "Custom implementation prompt",
    };

    const mockCreatedJob = {
      id: "job-123",
      userId: "test-user-id",
      repositoryUrl: "https://github.com/test/repo",
      githubToken: "ghp_test_token_12345",
      storyFile: "stories/user-story.md",
      architectureDoc: "docs/architecture.md",
      branchPrefix: "feature",
      featureBranch: "main",
      status: JobStatus.PENDING,
      createdAt: new Date("2023-01-01T10:00:00Z"),
      updatedAt: new Date("2023-01-01T10:00:00Z"),
    };

    it("should create new job successfully", async () => {
      mockJobService.createJob.mockResolvedValue(mockCreatedJob);
      mockJobQueueService.addJob.mockResolvedValue("queue-job-id-123");

      const response = await request(app)
        .post("/api/jobs")
        .send(validCreateRequest)
        .expect(201);

      expect(response.body).toMatchObject({
        success: true,
        message: "Job created successfully",
        data: {
          job: expect.objectContaining({
            id: "job-123",
            userId: "test-user-id",
            repositoryUrl: "https://github.com/test/repo",
            storyFile: "stories/user-story.md",
            architectureDoc: "docs/architecture.md",
            branchPrefix: "feature",
            featureBranch: "main",
            status: JobStatus.PENDING,
          }),
          sessionId: "mock-session-id-12345",
          streamUrl: "/api/jobs/job-123/stream?sessionId=mock-session-id-12345",
        },
      });

      expect(mockJobService.createJob).toHaveBeenCalledWith({
        userId: "test-user-id",
        repositoryUrl: "https://github.com/test/repo",
        githubToken: "ghp_test_token_12345",
        storyFile: "stories/user-story.md",
        architectureDoc: "docs/architecture.md",
        branchPrefix: "feature",
        featureBranch: "main",
      });

      expect(mockJobQueueService.addJob).toHaveBeenCalledWith({
        sessionId: "mock-session-id-12345",
        repositoryUrl: "https://github.com/test/repo",
        githubToken: "ghp_test_token_12345",
        storyFile: "stories/user-story.md",
        architectureDoc: "docs/architecture.md",
        options: {
          branchPrefix: "feature",
          featureBranch: "main",
          customPrompt: "Custom implementation prompt",
        },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "test-user-id",
          repositoryUrl: "https://github.com/test/repo",
          sessionId: "mock-session-id-12345",
          jobId: "job-123",
        }),
        "Job created and added to queue",
      );
    });

    it("should create job with minimal required fields", async () => {
      const minimalRequest = {
        repositoryUrl: "https://github.com/test/minimal",
        githubToken: "ghp_minimal_token",
        storyFile: "story.md",
        architectureDoc: "arch.md",
      };

      const minimalJob = {
        ...mockCreatedJob,
        repositoryUrl: "https://github.com/test/minimal",
        branchPrefix: "story", // Default value
        featureBranch: null,
      };

      mockJobService.createJob.mockResolvedValue(minimalJob);
      mockJobQueueService.addJob.mockResolvedValue("queue-job-id-456");

      const response = await request(app)
        .post("/api/jobs")
        .send(minimalRequest)
        .expect(201);

      expect(response.body.data.job.branchPrefix).toBe("story");
      expect(mockJobService.createJob).toHaveBeenCalledWith(
        expect.objectContaining({
          branchPrefix: "story",
        }),
      );
    });

    it("should return 400 for invalid request body", async () => {
      const invalidRequests = [
        { repositoryUrl: "invalid-url", githubToken: "token", storyFile: "file", architectureDoc: "doc" },
        { repositoryUrl: "https://github.com/test/repo", githubToken: "", storyFile: "file", architectureDoc: "doc" },
        { repositoryUrl: "https://github.com/test/repo", githubToken: "token", storyFile: "", architectureDoc: "doc" },
        { repositoryUrl: "https://github.com/test/repo", githubToken: "token", storyFile: "file", architectureDoc: "" },
        { repositoryUrl: "https://github.com/test/repo" }, // Missing required fields
      ];

      for (const invalidRequest of invalidRequests) {
        const response = await request(app)
          .post("/api/jobs")
          .send(invalidRequest)
          .expect(400);

        expect(response.body).toMatchObject({
          error: "Validation Error",
          message: "Invalid request data",
          details: expect.any(Array),
        });
      }
    });

    it("should return 401 when user is not authenticated", async () => {
      mockRequireJwt.mockImplementationOnce((req: any, res: any, next: any) => {
        res.status(401).json({
          error: "Authentication required",
          message: "You must be logged in to create jobs",
        });
      });

      mockGetAuthenticatedUser.mockReturnValueOnce(null);

      const response = await request(app)
        .post("/api/jobs")
        .send(validCreateRequest)
        .expect(401);

      expect(response.body).toMatchObject({
        error: "Authentication required",
        message: "You must be logged in to create jobs",
      });
    });

    it("should handle job service creation errors", async () => {
      const serviceError = new Error("Failed to create job in database");
      mockJobService.createJob.mockRejectedValue(serviceError);

      const response = await request(app)
        .post("/api/jobs")
        .send(validCreateRequest)
        .expect(500);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: serviceError.message,
          userId: "test-user-id",
        }),
        "Failed to create job",
      );
    });

    it("should handle job queue service errors", async () => {
      mockJobService.createJob.mockResolvedValue(mockCreatedJob);
      const queueError = new Error("Failed to add job to queue");
      mockJobQueueService.addJob.mockRejectedValue(queueError);

      const response = await request(app)
        .post("/api/jobs")
        .send(validCreateRequest)
        .expect(500);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: queueError.message,
          userId: "test-user-id",
        }),
        "Failed to create job",
      );
    });
  });

  describe("GET /api/jobs - List Jobs", () => {
    const mockJobs = [
      {
        id: "job-1",
        userId: "test-user-id",
        repositoryUrl: "https://github.com/test/repo1",
        githubToken: "token1",
        storyFile: "story1.md",
        architectureDoc: "arch1.md",
        branchPrefix: "feature",
        featureBranch: "main",
        status: JobStatus.COMPLETED,
        createdAt: new Date("2023-01-01T10:00:00Z"),
        updatedAt: new Date("2023-01-01T11:00:00Z"),
        jobExecutions: [
          {
            id: "exec-1",
            jobId: "job-1",
            sessionId: "session-1",
            status: JobStatus.COMPLETED,
            progress: 100,
            startedAt: new Date("2023-01-01T10:05:00Z"),
            completedAt: new Date("2023-01-01T11:00:00Z"),
            error: null,
          },
        ],
      },
      {
        id: "job-2",
        userId: "test-user-id",
        repositoryUrl: "https://github.com/test/repo2",
        githubToken: "token2",
        storyFile: "story2.md",
        architectureDoc: "arch2.md",
        branchPrefix: "story",
        featureBranch: null,
        status: JobStatus.IN_PROGRESS,
        createdAt: new Date("2023-01-02T10:00:00Z"),
        updatedAt: new Date("2023-01-02T10:30:00Z"),
        jobExecutions: [
          {
            id: "exec-2",
            jobId: "job-2",
            sessionId: "session-2",
            status: JobStatus.IN_PROGRESS,
            progress: 45,
            startedAt: new Date("2023-01-02T10:05:00Z"),
            completedAt: null,
            error: null,
          },
        ],
      },
    ];

    it("should return paginated jobs list successfully", async () => {
      mockPrisma.job.count.mockResolvedValue(2);
      mockPrisma.job.findMany.mockResolvedValue(mockJobs);

      const response = await request(app).get("/api/jobs").expect(200);

      expect(response.body).toMatchObject({
        data: expect.arrayContaining([
          expect.objectContaining({
            id: "job-1",
            repositoryUrl: "https://github.com/test/repo1",
            status: JobStatus.COMPLETED,
            execution: expect.objectContaining({
              id: "exec-1",
              status: JobStatus.COMPLETED,
              progress: {
                current: 100,
                total: 100,
                percentage: 100,
              },
            }),
          }),
          expect.objectContaining({
            id: "job-2",
            repositoryUrl: "https://github.com/test/repo2",
            status: JobStatus.IN_PROGRESS,
            execution: expect.objectContaining({
              id: "exec-2",
              status: JobStatus.IN_PROGRESS,
              progress: {
                current: 45,
                total: 100,
                percentage: 45,
              },
            }),
          }),
        ]),
        totalCount: 2,
        page: 1,
        limit: 20,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      });

      expect(mockPrisma.job.findMany).toHaveBeenCalledWith({
        where: { userId: "test-user-id" },
        orderBy: { createdAt: "desc" },
        take: 20,
        skip: 0,
        include: {
          jobExecutions: {
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      });
    });

    it("should handle pagination parameters", async () => {
      const manyJobs = Array.from({ length: 15 }, (_, i) => ({
        ...mockJobs[0],
        id: `job-${i + 1}`,
      }));

      mockPrisma.job.count.mockResolvedValue(75);
      mockPrisma.job.findMany.mockResolvedValue(manyJobs);

      const response = await request(app)
        .get("/api/jobs?page=2&limit=15")
        .expect(200);

      expect(response.body.page).toBe(2);
      expect(response.body.limit).toBe(15);
      expect(response.body.totalCount).toBe(75);
      expect(response.body.totalPages).toBe(5);
      expect(response.body.hasNextPage).toBe(true);
      expect(response.body.hasPreviousPage).toBe(true);

      expect(mockPrisma.job.findMany).toHaveBeenCalledWith({
        where: { userId: "test-user-id" },
        orderBy: { createdAt: "desc" },
        take: 15,
        skip: 15, // (page - 1) * limit = (2 - 1) * 15 = 15
        include: expect.any(Object),
      });
    });

    it("should enforce maximum limit of 100", async () => {
      mockPrisma.job.count.mockResolvedValue(0);
      mockPrisma.job.findMany.mockResolvedValue([]);

      const response = await request(app)
        .get("/api/jobs?limit=200")
        .expect(200);

      expect(mockPrisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 100,
        }),
      );
    });

    it("should return 400 for invalid pagination parameters", async () => {
      const response = await request(app)
        .get("/api/jobs?page=invalid&limit=abc")
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Validation Error",
        message: "Invalid query parameters",
        details: expect.any(Array),
      });
    });

    it("should only return jobs for authenticated user (user isolation)", async () => {
      // Create jobs for different users
      const userAJobs = [
        { ...mockJobs[0], userId: "user-a", id: "job-a1" },
        { ...mockJobs[1], userId: "user-a", id: "job-a2" },
      ];
      
      const userBJobs = [
        { ...mockJobs[0], userId: "user-b", id: "job-b1" },
      ];

      // Mock authenticated user as user-a
      mockGetAuthenticatedUser.mockReturnValue({
        id: "user-a",
        email: "usera@example.com",
      });

      mockPrisma.job.count.mockResolvedValue(2); // Only count for user-a
      mockPrisma.job.findMany.mockResolvedValue(userAJobs);

      const response = await request(app).get("/api/jobs").expect(200);

      expect(response.body.totalCount).toBe(2);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.data[0].id).toBe("job-a1");
      expect(response.body.data[1].id).toBe("job-a2");

      // Verify that the query filters by userId
      expect(mockPrisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user-a" },
        }),
      );

      expect(mockPrisma.job.count).toHaveBeenCalledWith({
        where: { userId: "user-a" },
      });
    });

    it("should return 401 when user is not authenticated", async () => {
      mockGetAuthenticatedUser.mockReturnValueOnce(null);

      const response = await request(app).get("/api/jobs").expect(401);

      expect(response.body).toMatchObject({
        error: "Authentication required",
        message: "You must be logged in to view jobs",
      });
    });

    it("should handle database errors gracefully", async () => {
      const dbError = new Error("Database connection failed");
      mockPrisma.job.count.mockRejectedValue(dbError);

      const response = await request(app).get("/api/jobs").expect(500);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: dbError.message,
          userId: "test-user-id",
        }),
        "Failed to list jobs",
      );
    });
  });

  describe("GET /api/jobs/:jobId - Get Job Details", () => {
    const mockJob = {
      id: "job-123",
      userId: "test-user-id",
      repositoryUrl: "https://github.com/test/repo",
      githubToken: "token",
      storyFile: "story.md",
      architectureDoc: "arch.md",
      branchPrefix: "feature",
      featureBranch: "main",
      status: JobStatus.COMPLETED,
      createdAt: new Date("2023-01-01T10:00:00Z"),
      updatedAt: new Date("2023-01-01T11:00:00Z"),
      jobExecutions: [
        {
          id: "exec-1",
          jobId: "job-123",
          sessionId: "session-1",
          status: JobStatus.COMPLETED,
          progress: 100,
          startedAt: new Date("2023-01-01T10:05:00Z"),
          completedAt: new Date("2023-01-01T11:00:00Z"),
          error: null,
        },
      ],
    };

    it("should return job details successfully", async () => {
      mockPrisma.job.findFirst.mockResolvedValue(mockJob);

      const response = await request(app)
        .get("/api/jobs/job-123")
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: expect.objectContaining({
          id: "job-123",
          userId: "test-user-id",
          repositoryUrl: "https://github.com/test/repo",
          status: JobStatus.COMPLETED,
          execution: expect.objectContaining({
            id: "exec-1",
            status: JobStatus.COMPLETED,
            progress: {
              current: 100,
              total: 100,
              percentage: 100,
            },
          }),
        }),
        message: "Job details retrieved successfully",
      });

      expect(mockPrisma.job.findFirst).toHaveBeenCalledWith({
        where: {
          id: "job-123",
          userId: "test-user-id",
        },
        include: {
          jobExecutions: {
            orderBy: { createdAt: "desc" },
          },
        },
      });
    });

    it("should return 400 for invalid job ID format", async () => {
      const response = await request(app)
        .get("/api/jobs/invalid-id")
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Validation Error",
        message: "Invalid job ID",
        details: expect.any(Array),
      });
    });

    it("should return 404 for non-existent job", async () => {
      mockPrisma.job.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/jobs/12345678-1234-1234-1234-123456789012")
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Job not found",
        message: "Job not found or you do not have access to it",
      });
    });

    it("should not allow access to other user's jobs", async () => {
      const otherUserJob = {
        ...mockJob,
        userId: "other-user-id",
      };

      mockPrisma.job.findFirst.mockResolvedValue(null); // Not found due to userId filter

      const response = await request(app)
        .get("/api/jobs/job-123")
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Job not found",
        message: "Job not found or you do not have access to it",
      });

      expect(mockPrisma.job.findFirst).toHaveBeenCalledWith({
        where: {
          id: "job-123",
          userId: "test-user-id", // Ensures user isolation
        },
        include: expect.any(Object),
      });
    });

    it("should return 401 when user is not authenticated", async () => {
      mockGetAuthenticatedUser.mockReturnValueOnce(null);

      const response = await request(app)
        .get("/api/jobs/job-123")
        .expect(401);

      expect(response.body).toMatchObject({
        error: "Authentication required",
        message: "You must be logged in to view job details",
      });
    });

    it("should handle database errors", async () => {
      const dbError = new Error("Database query failed");
      mockPrisma.job.findFirst.mockRejectedValue(dbError);

      const response = await request(app)
        .get("/api/jobs/12345678-1234-1234-1234-123456789012")
        .expect(500);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: dbError.message,
          userId: "test-user-id",
        }),
        "Failed to get job details",
      );
    });
  });

  describe("GET /api/jobs/:jobId/stream - SSE Stream", () => {
    const mockJob = {
      id: "job-123",
      userId: "test-user-id",
      repositoryUrl: "https://github.com/test/repo",
      status: JobStatus.IN_PROGRESS,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("should establish SSE connection successfully", async () => {
      mockPrisma.job.findFirst.mockResolvedValue(mockJob);

      const response = await request(app)
        .get("/api/jobs/job-123/stream?sessionId=session-123")
        .expect(200);

      expect(mockPrisma.job.findFirst).toHaveBeenCalledWith({
        where: {
          id: "job-123",
          userId: "test-user-id",
        },
      });

      expect(mockSseService.connect).toHaveBeenCalledWith(
        "session-123",
        expect.any(Object),
        "job-123",
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "test-user-id",
          jobId: "job-123",
          sessionId: "session-123",
        }),
        "Job stream connected",
      );
    });

    it("should return 400 for invalid job ID format", async () => {
      const response = await request(app)
        .get("/api/jobs/invalid-id/stream?sessionId=session-123")
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Validation Error",
        message: "Invalid job ID",
      });
    });

    it("should return 400 when sessionId is missing", async () => {
      const response = await request(app)
        .get("/api/jobs/12345678-1234-1234-1234-123456789012/stream")
        .expect(400);

      expect(response.body).toMatchObject({
        error: "Missing sessionId",
        message: "sessionId query parameter is required for streaming",
      });
    });

    it("should return 404 for non-existent job", async () => {
      mockPrisma.job.findFirst.mockResolvedValue(null);

      const response = await request(app)
        .get("/api/jobs/12345678-1234-1234-1234-123456789012/stream?sessionId=session-123")
        .expect(404);

      expect(response.body).toMatchObject({
        error: "Job not found",
        message: "Job not found or you do not have access to it",
      });
    });

    it("should not allow streaming other user's jobs", async () => {
      mockPrisma.job.findFirst.mockResolvedValue(null); // Not found due to userId filter

      const response = await request(app)
        .get("/api/jobs/job-123/stream?sessionId=session-123")
        .expect(404);

      expect(mockPrisma.job.findFirst).toHaveBeenCalledWith({
        where: {
          id: "job-123",
          userId: "test-user-id", // Ensures user isolation
        },
      });
    });

    it("should return 401 when user is not authenticated", async () => {
      mockGetAuthenticatedUser.mockReturnValueOnce(null);

      const response = await request(app)
        .get("/api/jobs/job-123/stream?sessionId=session-123")
        .expect(401);

      expect(response.body).toMatchObject({
        error: "Authentication required",
        message: "You must be logged in to stream job updates",
      });
    });

    it("should handle database errors during job verification", async () => {
      const dbError = new Error("Database connection failed");
      mockPrisma.job.findFirst.mockRejectedValue(dbError);

      const response = await request(app)
        .get("/api/jobs/12345678-1234-1234-1234-123456789012/stream?sessionId=session-123")
        .expect(500);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: dbError.message,
          userId: "test-user-id",
        }),
        "Failed to setup job stream",
      );
    });
  });

  describe("Authentication and Authorization", () => {
    it("should require authentication for all endpoints", async () => {
      const endpoints = [
        { method: "post", path: "/api/jobs" },
        { method: "get", path: "/api/jobs" },
        { method: "get", path: "/api/jobs/12345678-1234-1234-1234-123456789012" },
        { method: "get", path: "/api/jobs/12345678-1234-1234-1234-123456789012/stream" },
      ];

      mockRequireJwt.mockImplementation((req: any, res: any, next: any) => {
        res.status(401).json({
          error: "Unauthorized",
          message: "Authentication required",
        });
      });

      for (const endpoint of endpoints) {
        const response = await request(app)
          [endpoint.method as keyof typeof request](endpoint.path)
          .send({})
          .expect(401);

        expect(response.body.error).toBe("Unauthorized");
      }
    });

    it("should pass user information to request handlers", async () => {
      const testUserId = "test-user-123";
      mockRequireJwt.mockImplementation((req: any, res: any, next: any) => {
        req.user = { id: testUserId, email: "test@example.com" };
        next();
      });

      mockGetAuthenticatedUser.mockReturnValue({
        id: testUserId,
        email: "test@example.com",
      });

      mockPrisma.job.findMany.mockResolvedValue([]);
      mockPrisma.job.count.mockResolvedValue(0);

      await request(app).get("/api/jobs").expect(200);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: testUserId,
        }),
        "User jobs retrieved successfully",
      );
    });
  });

  describe("Request Correlation", () => {
    it("should include request ID in responses and logs", async () => {
      const requestId = createId();
      mockPrisma.job.findMany.mockResolvedValue([]);
      mockPrisma.job.count.mockResolvedValue(0);

      const response = await request(app)
        .get("/api/jobs")
        .set("x-request-id", requestId)
        .expect(200);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId,
        }),
        "User jobs retrieved successfully",
      );
    });

    it("should generate request ID if not provided", async () => {
      mockPrisma.job.findMany.mockResolvedValue([]);
      mockPrisma.job.count.mockResolvedValue(0);

      const response = await request(app).get("/api/jobs").expect(200);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: expect.any(String),
        }),
        "User jobs retrieved successfully",
      );
    });
  });

  describe("Data Validation and Sanitization", () => {
    it("should redact sensitive values in logs during job creation", async () => {
      const requestWithSensitiveData = {
        repositoryUrl: "https://github.com/test/repo",
        githubToken: "ghp_sensitive_token_value_12345",
        storyFile: "story.md",
        architectureDoc: "arch.md",
      };

      const mockJob = {
        id: "job-123",
        userId: "test-user-id",
        ...requestWithSensitiveData,
        status: JobStatus.PENDING,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockJobService.createJob.mockResolvedValue(mockJob);
      mockJobQueueService.addJob.mockResolvedValue("queue-job-123");

      await request(app)
        .post("/api/jobs")
        .send(requestWithSensitiveData)
        .expect(201);

      // Verify that sensitive data is redacted in logs
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryUrl: "https://github.com/test/repo",
          // githubToken should not appear in logs or be redacted
        }),
        "Creating new job",
      );

      // Ensure the actual token is not logged
      const logCalls = mockLogger.info.mock.calls;
      const hasTokenInLogs = logCalls.some(call => 
        JSON.stringify(call).includes("ghp_sensitive_token_value_12345")
      );
      expect(hasTokenInLogs).toBe(false);
    });
  });

  describe("Error Handling", () => {
    it("should handle malformed request data gracefully", async () => {
      const testCases = [
        { endpoint: "/api/jobs?page=abc&limit=xyz", method: "get" },
        { endpoint: "/api/jobs/invalid-uuid", method: "get" },
        { endpoint: "/api/jobs/invalid-uuid/stream", method: "get" },
      ];

      for (const testCase of testCases) {
        const response = await request(app)
          [testCase.method as keyof typeof request](testCase.endpoint)
          .expect(400);

        expect(response.body.error).toBe("Validation Error");
        expect(response.body.details).toBeDefined();
      }
    });

    it("should include timestamp in all error responses", async () => {
      mockPrisma.job.findMany.mockRejectedValue(
        new Error("Database error"),
      );

      const response = await request(app).get("/api/jobs").expect(500);

      expect(response.body.timestamp).toBeDefined();
      expect(new Date(response.body.timestamp)).toBeInstanceOf(Date);
    });

    it("should handle service integration failures", async () => {
      // Test job creation failure scenarios
      const jobServiceError = new Error("Job service unavailable");
      const queueServiceError = new Error("Queue service unavailable");

      // Job service failure
      mockJobService.createJob.mockRejectedValueOnce(jobServiceError);
      
      let response = await request(app)
        .post("/api/jobs")
        .send({
          repositoryUrl: "https://github.com/test/repo",
          githubToken: "token",
          storyFile: "story.md",
          architectureDoc: "arch.md",
        })
        .expect(500);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: jobServiceError.message,
        }),
        "Failed to create job",
      );

      jest.clearAllMocks();

      // Queue service failure
      mockJobService.createJob.mockResolvedValueOnce({
        id: "job-123",
        userId: "test-user-id",
        status: JobStatus.PENDING,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockJobQueueService.addJob.mockRejectedValueOnce(queueServiceError);

      response = await request(app)
        .post("/api/jobs")
        .send({
          repositoryUrl: "https://github.com/test/repo",
          githubToken: "token",
          storyFile: "story.md",
          architectureDoc: "arch.md",
        })
        .expect(500);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: queueServiceError.message,
        }),
        "Failed to create job",
      );
    });
  });
});