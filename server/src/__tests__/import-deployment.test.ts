import { testPrisma, createTestUser } from "./setup";
import { StackTemplateService, TemplateError } from "../services/stacks/stack-template-service";

describe("importDeploymentConfig", () => {
  let service: StackTemplateService;
  let testEnvironmentId: string;
  let testUserId: string;

  beforeEach(async () => {
    // Clean up database in dependency order
    await testPrisma.stackTemplateService.deleteMany();
    await testPrisma.stackTemplateConfigFile.deleteMany();
    await testPrisma.stackTemplateVersion.deleteMany();
    await testPrisma.stackTemplate.deleteMany();
    await testPrisma.deployment.deleteMany();
    await testPrisma.deploymentStep.deleteMany();
    await testPrisma.deploymentConfiguration.deleteMany();
    await testPrisma.environment.deleteMany();
    await testPrisma.user.deleteMany();

    // Create test environment
    const environment = await testPrisma.environment.create({
      data: {
        name: "test-env",
        description: "Test environment",
        type: "nonproduction",
        status: "initialized",
        isActive: true,
      },
    });
    testEnvironmentId = environment.id;

    // Create test user
    const user = await createTestUser();
    testUserId = user.id;

    service = new StackTemplateService(testPrisma);
  });

  afterEach(async () => {
    await testPrisma.stackTemplateService.deleteMany();
    await testPrisma.stackTemplateConfigFile.deleteMany();
    await testPrisma.stackTemplateVersion.deleteMany();
    await testPrisma.stackTemplate.deleteMany();
    await testPrisma.deployment.deleteMany();
    await testPrisma.deploymentStep.deleteMany();
    await testPrisma.deploymentConfiguration.deleteMany();
    await testPrisma.environment.deleteMany();
    await testPrisma.user.deleteMany();
  });

  async function createDeploymentConfig(overrides: Record<string, any> = {}) {
    const { hostname, listeningPort, enableSsl, tlsCertificateId, ...restOverrides } = overrides;
    return testPrisma.deploymentConfiguration.create({
      data: {
        applicationName: "my-web-app",
        dockerImage: "my-app",
        dockerTag: "v1.2.3",
        dockerRegistry: "ghcr.io/owner",
        containerConfig: {
          ports: [{ containerPort: 3000, hostPort: 3000, protocol: "tcp" }],
          volumes: [{ hostPath: "/data/app", containerPath: "/app/data", mode: "rw" }],
          environment: [
            { name: "NODE_ENV", value: "production" },
            { name: "PORT", value: "3000" },
          ],
          labels: { "app.name": "my-web-app" },
          networks: ["app-network"],
        },
        healthCheckConfig: {
          endpoint: "/health",
          method: "GET",
          expectedStatus: [200],
          timeout: 5000,
          retries: 3,
          interval: 10000,
        },
        rollbackConfig: {
          enabled: true,
          maxWaitTime: 30000,
          keepOldContainer: false,
        },
        environmentId: testEnvironmentId,
        hostname: hostname !== undefined ? hostname : "app.example.com",
        listeningPort: listeningPort !== undefined ? listeningPort : 3000,
        enableSsl: enableSsl !== undefined ? enableSsl : true,
        tlsCertificateId: tlsCertificateId !== undefined ? tlsCertificateId : null,
        isActive: true,
        ...restOverrides,
      },
    });
  }

  it("should import a deployment config with routing as StatelessWeb", async () => {
    const config = await createDeploymentConfig();

    const template = await service.importDeploymentConfig(config.id, testUserId);

    // Template metadata
    expect(template.name).toBe("my-web-app");
    expect(template.displayName).toBe("my-web-app");
    expect(template.source).toBe("user");
    expect(template.scope).toBe("environment");

    // Should have a published version (not draft)
    expect(template.currentVersion).toBeDefined();
    expect(template.currentVersion!.status).toBe("published");
    expect(template.currentVersion!.version).toBe(1);
    expect(template.draftVersion).toBeNull();

    // Check the service
    const version = template.currentVersion!;
    expect(version.services).toHaveLength(1);
    const svc = version.services![0];
    expect(svc.serviceName).toBe("my-web-app");
    expect(svc.serviceType).toBe("StatelessWeb");
    expect(svc.dockerImage).toBe("ghcr.io/owner/my-app");
    expect(svc.dockerTag).toBe("v1.2.3");

    // Container config
    const cc = svc.containerConfig as any;
    expect(cc.env).toEqual({ NODE_ENV: "production", PORT: "3000" });
    expect(cc.ports).toEqual([{ containerPort: 3000, hostPort: 3000, protocol: "tcp" }]);
    expect(cc.mounts).toEqual([
      { source: "/data/app", target: "/app/data", type: "bind", readOnly: false },
    ]);
    expect(cc.labels).toEqual({ "app.name": "my-web-app" });
    expect(cc.joinNetworks).toEqual(["app-network"]);
    expect(cc.healthcheck).toBeDefined();
    expect(cc.healthcheck.test).toEqual([
      "CMD-SHELL",
      "curl -f -X GET http://localhost:3000/health || exit 1",
    ]);

    // Routing
    expect(svc.routing).toBeDefined();
    expect(svc.routing!.hostname).toBe("app.example.com");
    expect(svc.routing!.listeningPort).toBe(3000);
    expect(svc.routing!.enableSsl).toBe(true);
    // tlsCertificateId is null in the test data (FK constraint)
    expect(svc.routing!.enableSsl).toBe(true);

    // Default parameter values (rollback + environment)
    const dpv = version.defaultParameterValues as any;
    expect(dpv.rollbackEnabled).toBe(true);
    expect(dpv.rollbackMaxWaitTime).toBe(30000);
    expect(dpv.rollbackKeepOldContainer).toBe(false);
    expect(dpv.environmentId).toBe(testEnvironmentId);
  });

  it("should import a deployment config without routing as Stateful", async () => {
    const config = await createDeploymentConfig({
      hostname: null,
      listeningPort: null,
      enableSsl: false,
      tlsCertificateId: null,
    });

    const template = await service.importDeploymentConfig(config.id, testUserId);

    const svc = template.currentVersion!.services![0];
    expect(svc.serviceType).toBe("Stateful");
    expect(svc.routing).toBeNull();
  });

  it("should import without registry prefix when dockerRegistry is null", async () => {
    const config = await createDeploymentConfig({ dockerRegistry: null });

    const template = await service.importDeploymentConfig(config.id, testUserId);

    const svc = template.currentVersion!.services![0];
    expect(svc.dockerImage).toBe("my-app");
  });

  it("should return 404 for missing deployment configuration", async () => {
    try {
      await service.importDeploymentConfig("nonexistent-id", testUserId);
      fail("Expected importDeploymentConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateError);
      expect((error as TemplateError).statusCode).toBe(404);
      expect((error as TemplateError).message).toBe("Deployment configuration not found");
    }
  });
});
