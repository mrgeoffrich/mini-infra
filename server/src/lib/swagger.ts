import swaggerJsdoc from 'swagger-jsdoc';
import { SwaggerDefinition } from 'swagger-jsdoc';
import appConfig from './config-new';

const swaggerDefinition: SwaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'Mini Infra API',
    version: '0.1.0',
    description: 'API for managing Docker containers, PostgreSQL databases, zero-downtime deployments, and infrastructure monitoring',
    contact: {
      name: 'Mini Infra',
    },
  },
  servers: [
    {
      url: appConfig.server.publicUrl || `http://localhost:${appConfig.server.port}`,
      description: 'Development server',
    },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT token from /auth/login',
      },
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'Development API key (use npm run show-dev-key in server directory)',
      },
      ApiKeyAuthBearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'API key as Bearer token',
      },
    },
    parameters: {
      // ====================
      // Common Query Parameters
      // ====================
      PageParam: {
        name: 'page',
        in: 'query',
        description: 'Page number for pagination (1-based)',
        required: false,
        schema: {
          type: 'integer',
          minimum: 1,
          default: 1,
        },
        example: 1,
      },
      LimitParam: {
        name: 'limit',
        in: 'query',
        description: 'Number of items per page',
        required: false,
        schema: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 20,
        },
        example: 20,
      },
      SearchParam: {
        name: 'search',
        in: 'query',
        description: 'Search term for filtering results',
        required: false,
        schema: {
          type: 'string',
          maxLength: 255,
        },
        example: 'nginx',
      },
      SortByParam: {
        name: 'sortBy',
        in: 'query',
        description: 'Field to sort by',
        required: false,
        schema: {
          type: 'string',
        },
        example: 'name',
      },
      SortOrderParam: {
        name: 'sortOrder',
        in: 'query',
        description: 'Sort order',
        required: false,
        schema: {
          type: 'string',
          enum: ['asc', 'desc'],
          default: 'asc',
        },
        example: 'asc',
      },
      // ====================
      // Common Path Parameters
      // ====================
      IdParam: {
        name: 'id',
        in: 'path',
        description: 'Resource unique identifier',
        required: true,
        schema: {
          type: 'string',
          pattern: '^[a-zA-Z0-9_-]+$',
        },
        example: 'clk123abc456',
      },
      ContainerIdParam: {
        name: 'id',
        in: 'path',
        description: 'Container unique identifier',
        required: true,
        schema: {
          type: 'string',
          pattern: '^[a-zA-Z0-9_-]+$',
        },
        example: 'nginx-container-123',
      },
      DatabaseIdParam: {
        name: 'databaseId',
        in: 'path',
        description: 'Database configuration unique identifier',
        required: true,
        schema: {
          type: 'string',
          pattern: '^[a-zA-Z0-9_-]+$',
        },
        example: 'postgres-main-db',
      },
      DeploymentIdParam: {
        name: 'deploymentId',
        in: 'path',
        description: 'Deployment unique identifier',
        required: true,
        schema: {
          type: 'string',
          pattern: '^[a-zA-Z0-9_-]+$',
        },
        example: 'deploy-123',
      },
      EnvironmentIdParam: {
        name: 'id',
        in: 'path',
        description: 'Environment unique identifier',
        required: true,
        schema: {
          type: 'string',
          pattern: '^[a-zA-Z0-9_-]+$',
        },
        example: 'production-env-123',
      },
      OperationIdParam: {
        name: 'operationId',
        in: 'path',
        description: 'Operation unique identifier',
        required: true,
        schema: {
          type: 'string',
          pattern: '^[a-zA-Z0-9_-]+$',
        },
        example: 'backup-op-123',
      },
      ApplicationNameParam: {
        name: 'applicationName',
        in: 'path',
        description: 'Application name',
        required: true,
        schema: {
          type: 'string',
          pattern: '^[a-zA-Z0-9_-]+$',
        },
        example: 'my-web-app',
      },
      ServiceParam: {
        name: 'service',
        in: 'path',
        description: 'Service name',
        required: true,
        schema: {
          type: 'string',
          enum: ['azure', 'cloudflare', 'docker'],
        },
        example: 'azure',
      },
    },
    schemas: {
      // ====================
      // Common API Response Schemas
      // ====================
      ApiResponse: {
        type: 'object',
        properties: {
          success: {
            type: 'boolean',
            description: 'Indicates if the request was successful',
          },
          message: {
            type: 'string',
            description: 'Human-readable message',
          },
          data: {
            description: 'Response data (varies by endpoint)',
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
            description: 'Response timestamp',
          },
          requestId: {
            type: 'string',
            description: 'Unique request identifier',
          },
        },
        required: ['success'],
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          success: {
            type: 'boolean',
            example: false,
          },
          error: {
            type: 'string',
            description: 'Error message',
          },
          message: {
            type: 'string',
            description: 'Human-readable error message',
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
          },
          requestId: {
            type: 'string',
            description: 'Unique request identifier',
          },
          details: {
            description: 'Additional error details (optional)',
          },
        },
        required: ['success', 'error', 'message', 'timestamp'],
      },
      ValidationError: {
        type: 'object',
        properties: {
          error: {
            type: 'string',
            example: 'Validation failed',
          },
          message: {
            type: 'string',
            description: 'Human-readable error message',
          },
          details: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                expected: { type: 'string' },
                received: { type: 'string' },
                path: { type: 'array', items: { type: 'string' } },
                message: { type: 'string' },
              },
            },
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
          },
          requestId: {
            type: 'string',
            description: 'Unique request identifier',
          },
        },
        required: ['error', 'message', 'details', 'timestamp'],
      },
      HealthResponse: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['healthy', 'unhealthy'],
            example: 'healthy',
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
          },
          environment: {
            type: 'string',
            enum: ['development', 'production', 'test'],
          },
          uptime: {
            type: 'number',
            description: 'Server uptime in seconds',
          },
          services: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                status: {
                  type: 'string',
                  enum: ['connected', 'disconnected', 'error'],
                },
                message: { type: 'string' },
              },
            },
          },
        },
        required: ['status', 'timestamp', 'environment', 'uptime'],
      },
      // ====================
      // Pagination Schemas
      // ====================
      PaginatedResponse: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: {},
            description: 'Array of data items',
          },
          totalCount: {
            type: 'integer',
            description: 'Total number of items',
          },
          page: {
            type: 'integer',
            description: 'Current page number',
          },
          limit: {
            type: 'integer',
            description: 'Items per page',
          },
          totalPages: {
            type: 'integer',
            description: 'Total number of pages',
          },
          hasNextPage: {
            type: 'boolean',
            description: 'Whether there is a next page',
          },
          hasPreviousPage: {
            type: 'boolean',
            description: 'Whether there is a previous page',
          },
        },
        required: ['data', 'totalCount', 'page', 'limit', 'totalPages', 'hasNextPage', 'hasPreviousPage'],
      },
      // ====================
      // Authentication & User Schemas
      // ====================
      User: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'User unique identifier',
          },
          email: {
            type: 'string',
            format: 'email',
            description: 'User email address',
          },
          name: {
            type: 'string',
            nullable: true,
            description: 'User display name',
          },
          image: {
            type: 'string',
            nullable: true,
            description: 'User profile image URL',
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
          },
          updatedAt: {
            type: 'string',
            format: 'date-time',
          },
        },
        required: ['id', 'email', 'createdAt', 'updatedAt'],
      },
      AuthStatus: {
        type: 'object',
        properties: {
          isAuthenticated: {
            type: 'boolean',
            description: 'Whether the user is authenticated',
          },
          user: {
            nullable: true,
            oneOf: [
              { $ref: '#/components/schemas/User' },
              { type: 'null' },
            ],
          },
        },
        required: ['isAuthenticated', 'user'],
      },
      ApiKeyInfo: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'API key unique identifier',
          },
          name: {
            type: 'string',
            description: 'API key name',
          },
          active: {
            type: 'boolean',
            description: 'Whether the API key is active',
          },
          lastUsedAt: {
            type: 'string',
            format: 'date-time',
            nullable: true,
            description: 'Last usage timestamp',
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
          },
          updatedAt: {
            type: 'string',
            format: 'date-time',
          },
        },
        required: ['id', 'name', 'active', 'createdAt', 'updatedAt'],
      },
      CreateApiKeyRequest: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name for the API key',
            minLength: 1,
            maxLength: 100,
          },
        },
        required: ['name'],
      },
      CreateApiKeyResponse: {
        allOf: [
          { $ref: '#/components/schemas/ApiKeyInfo' },
          {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: 'The API key (only shown on creation)',
              },
            },
            required: ['key'],
          },
        ],
      },
      UserPreferenceInfo: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'User preference unique identifier',
          },
          containerSortField: {
            type: 'string',
            nullable: true,
            description: 'Default container sort field',
          },
          containerSortOrder: {
            type: 'string',
            enum: ['asc', 'desc'],
            nullable: true,
            description: 'Default container sort order',
          },
          containerFilters: {
            type: 'object',
            nullable: true,
            description: 'Default container filters',
          },
          containerColumns: {
            type: 'object',
            nullable: true,
            description: 'Container column visibility preferences',
          },
          timezone: {
            type: 'string',
            nullable: true,
            description: 'User timezone preference',
            default: 'UTC',
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
          },
          updatedAt: {
            type: 'string',
            format: 'date-time',
          },
        },
        required: ['id', 'createdAt', 'updatedAt'],
      },
      UpdateUserPreferencesRequest: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description: 'User timezone',
          },
          containerSortField: {
            type: 'string',
            description: 'Default container sort field',
          },
          containerSortOrder: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'Default container sort order',
          },
          containerFilters: {
            type: 'object',
            description: 'Default container filters',
          },
          containerColumns: {
            type: 'object',
            description: 'Container column visibility preferences',
          },
        },
      },
      TimezoneInfo: {
        type: 'object',
        properties: {
          value: {
            type: 'string',
            description: 'Timezone identifier (e.g., America/New_York)',
          },
          label: {
            type: 'string',
            description: 'Human-readable timezone label',
          },
          offset: {
            type: 'string',
            description: 'UTC offset (e.g., -05:00)',
          },
        },
        required: ['value', 'label', 'offset'],
      },
      // ====================
      // Container Schemas
      // ====================
      ContainerInfo: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Docker container ID',
          },
          name: {
            type: 'string',
            description: 'Container name',
          },
          image: {
            type: 'string',
            description: 'Docker image name',
          },
          state: {
            type: 'string',
            enum: ['running', 'paused', 'restarting', 'removing', 'dead', 'created', 'exited'],
            description: 'Container state',
          },
          status: {
            type: 'string',
            description: 'Human-readable status',
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
            description: 'Container creation timestamp',
          },
          startedAt: {
            type: 'string',
            format: 'date-time',
            nullable: true,
            description: 'Container start timestamp',
          },
          ports: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                privatePort: { type: 'number' },
                publicPort: { type: 'number', nullable: true },
                type: { type: 'string', enum: ['tcp', 'udp'] },
                ip: { type: 'string', nullable: true },
              },
            },
          },
          labels: {
            type: 'object',
            additionalProperties: {
              type: 'string',
            },
            description: 'Container labels',
          },
          networks: {
            type: 'array',
            items: {
              type: 'string',
            },
            description: 'Networks the container is connected to',
          },
        },
        required: ['id', 'name', 'image', 'state', 'status', 'createdAt'],
      },
      ContainerCacheStats: {
        type: 'object',
        properties: {
          totalEntries: {
            type: 'integer',
            description: 'Total number of cache entries',
          },
          activeEntries: {
            type: 'integer',
            description: 'Number of non-expired cache entries',
          },
          expiredEntries: {
            type: 'integer',
            description: 'Number of expired cache entries',
          },
          oldestEntry: {
            type: 'string',
            format: 'date-time',
            nullable: true,
            description: 'Timestamp of oldest cache entry',
          },
          newestEntry: {
            type: 'string',
            format: 'date-time',
            nullable: true,
            description: 'Timestamp of newest cache entry',
          },
        },
        required: ['totalEntries', 'activeEntries', 'expiredEntries'],
      },
      // ====================
      // Deployment Container Schemas
      // ====================
      DeploymentContainerInfo: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Deployment container unique identifier',
          },
          deploymentId: {
            type: 'string',
            description: 'Deployment ID this container belongs to',
          },
          containerId: {
            type: 'string',
            description: 'Docker container ID',
          },
          containerName: {
            type: 'string',
            description: 'Container name',
          },
          containerRole: {
            type: 'string',
            description: 'Container role in deployment',
            enum: ['old', 'new', 'blue', 'green'],
          },
          dockerImage: {
            type: 'string',
            description: 'Full Docker image with tag',
          },
          imageId: {
            type: 'string',
            nullable: true,
            description: 'Docker image ID (sha256:...)',
          },
          containerConfig: {
            type: 'object',
            description: 'Container configuration (excluding sensitive environment variables)',
          },
          status: {
            type: 'string',
            description: 'Container status when captured',
          },
          ipAddress: {
            type: 'string',
            nullable: true,
            description: 'Container IP address',
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
            description: 'When container was created',
          },
          startedAt: {
            type: 'string',
            format: 'date-time',
            nullable: true,
            description: 'When container started',
          },
          capturedAt: {
            type: 'string',
            format: 'date-time',
            description: 'When this record was created',
          },
        },
        required: ['id', 'deploymentId', 'containerId', 'containerName', 'containerRole', 'dockerImage', 'status', 'createdAt', 'capturedAt'],
      },
      // ====================
      // Deployment Schemas
      // ====================
      DeploymentPort: {
        type: 'object',
        properties: {
          containerPort: {
            type: 'integer',
            minimum: 1,
            maximum: 65535,
            description: 'Container port',
          },
          hostPort: {
            type: 'integer',
            minimum: 1,
            maximum: 65535,
            nullable: true,
            description: 'Host port',
          },
          protocol: {
            type: 'string',
            enum: ['tcp', 'udp'],
            default: 'tcp',
          },
        },
        required: ['containerPort'],
      },
      DeploymentVolume: {
        type: 'object',
        properties: {
          hostPath: {
            type: 'string',
            description: 'Host filesystem path',
          },
          containerPath: {
            type: 'string',
            description: 'Container filesystem path',
          },
          mode: {
            type: 'string',
            enum: ['rw', 'ro'],
            default: 'rw',
            description: 'Mount mode (read-write or read-only)',
          },
        },
        required: ['hostPath', 'containerPath'],
      },
      ContainerEnvVar: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Environment variable name',
          },
          value: {
            type: 'string',
            description: 'Environment variable value',
          },
        },
        required: ['name', 'value'],
      },
      ContainerConfig: {
        type: 'object',
        properties: {
          ports: {
            type: 'array',
            items: { $ref: '#/components/schemas/DeploymentPort' },
            description: 'Port mappings',
          },
          volumes: {
            type: 'array',
            items: { $ref: '#/components/schemas/DeploymentVolume' },
            description: 'Volume mounts',
          },
          environment: {
            type: 'array',
            items: { $ref: '#/components/schemas/ContainerEnvVar' },
            description: 'Environment variables',
          },
          labels: {
            type: 'object',
            additionalProperties: {
              type: 'string',
            },
            description: 'Container labels',
          },
          networks: {
            type: 'array',
            items: {
              type: 'string',
            },
            description: 'Networks to connect to',
          },
        },
        required: ['ports', 'volumes', 'environment', 'labels', 'networks'],
      },
      HealthCheckConfig: {
        type: 'object',
        properties: {
          endpoint: {
            type: 'string',
            description: 'Health check endpoint URL',
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST'],
            default: 'GET',
          },
          expectedStatus: {
            type: 'array',
            items: {
              type: 'integer',
            },
            description: 'Expected HTTP status codes',
            default: [200],
          },
          responseValidation: {
            type: 'string',
            nullable: true,
            description: 'Regex pattern for response validation',
          },
          timeout: {
            type: 'integer',
            minimum: 1000,
            maximum: 30000,
            description: 'Timeout in milliseconds',
            default: 5000,
          },
          retries: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
            description: 'Number of retries',
            default: 3,
          },
          interval: {
            type: 'integer',
            minimum: 1000,
            maximum: 60000,
            description: 'Interval between checks in milliseconds',
            default: 10000,
          },
        },
        required: ['endpoint'],
      },
      RollbackConfig: {
        type: 'object',
        properties: {
          enabled: {
            type: 'boolean',
            description: 'Whether rollback is enabled',
            default: true,
          },
          maxWaitTime: {
            type: 'integer',
            minimum: 30000,
            maximum: 600000,
            description: 'Maximum wait time in milliseconds',
            default: 300000,
          },
          keepOldContainer: {
            type: 'boolean',
            description: 'Whether to keep old container after successful deployment',
            default: false,
          },
        },
        required: ['enabled'],
      },
      DeploymentConfigurationInfo: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Unique deployment configuration ID',
          },
          applicationName: {
            type: 'string',
            description: 'Application name',
          },
          dockerImage: {
            type: 'string',
            description: 'Docker image to deploy',
          },
          dockerRegistry: {
            type: 'string',
            nullable: true,
            description: 'Docker registry URL',
          },
          containerConfig: {
            $ref: '#/components/schemas/ContainerConfig',
          },
          healthCheckConfig: {
            $ref: '#/components/schemas/HealthCheckConfig',
          },
          rollbackConfig: {
            $ref: '#/components/schemas/RollbackConfig',
          },
          listeningPort: {
            type: 'integer',
            nullable: true,
            description: 'Application listening port',
          },
          hostname: {
            type: 'string',
            nullable: true,
            description: 'Public hostname for the application',
          },
          isActive: {
            type: 'boolean',
            description: 'Whether the configuration is active',
          },
          environmentId: {
            type: 'string',
            description: 'Environment ID',
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
          },
          updatedAt: {
            type: 'string',
            format: 'date-time',
          },
        },
        required: ['id', 'applicationName', 'dockerImage', 'containerConfig', 'healthCheckConfig', 'rollbackConfig', 'isActive', 'environmentId', 'createdAt', 'updatedAt'],
      },
      CreateDeploymentConfigRequest: {
        type: 'object',
        properties: {
          applicationName: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
            description: 'Application name',
          },
          dockerImage: {
            type: 'string',
            description: 'Docker image to deploy',
          },
          dockerRegistry: {
            type: 'string',
            nullable: true,
            description: 'Docker registry URL',
          },
          containerConfig: {
            $ref: '#/components/schemas/ContainerConfig',
          },
          healthCheckConfig: {
            $ref: '#/components/schemas/HealthCheckConfig',
          },
          rollbackConfig: {
            $ref: '#/components/schemas/RollbackConfig',
          },
          listeningPort: {
            type: 'integer',
            nullable: true,
            description: 'Application listening port',
          },
          hostname: {
            type: 'string',
            nullable: true,
            description: 'Public hostname for the application',
          },
          environmentId: {
            type: 'string',
            description: 'Environment ID',
          },
        },
        required: ['applicationName', 'dockerImage', 'containerConfig', 'healthCheckConfig', 'rollbackConfig', 'environmentId'],
      },
      DeploymentInfo: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Deployment unique identifier',
          },
          configurationId: {
            type: 'string',
            description: 'Deployment configuration ID',
          },
          triggerType: {
            type: 'string',
            enum: ['manual', 'webhook', 'scheduled', 'uninstall'],
            description: 'How the deployment was triggered',
          },
          triggeredBy: {
            type: 'string',
            nullable: true,
            description: 'User or API key that triggered the deployment',
          },
          dockerImage: {
            type: 'string',
            description: 'Full Docker image with tag',
          },
          status: {
            type: 'string',
            enum: ['pending', 'preparing', 'deploying', 'health_checking', 'switching_traffic', 'cleanup', 'completed', 'failed', 'rolling_back', 'uninstalling', 'removing_from_lb', 'stopping_application', 'removing_application', 'uninstalled'],
            description: 'Deployment status',
          },
          currentState: {
            type: 'string',
            description: 'Current state machine state',
          },
          startedAt: {
            type: 'string',
            format: 'date-time',
          },
          completedAt: {
            type: 'string',
            format: 'date-time',
            nullable: true,
          },
          oldContainerId: {
            type: 'string',
            nullable: true,
            description: 'Previous container ID',
          },
          newContainerId: {
            type: 'string',
            nullable: true,
            description: 'New container ID',
          },
          healthCheckPassed: {
            type: 'boolean',
            description: 'Whether health checks passed',
          },
          healthCheckLogs: {
            type: 'object',
            nullable: true,
            description: 'Health check logs',
          },
          errorMessage: {
            type: 'string',
            nullable: true,
            description: 'Error message if deployment failed',
          },
          errorDetails: {
            type: 'object',
            nullable: true,
            description: 'Detailed error information',
          },
          deploymentTime: {
            type: 'integer',
            nullable: true,
            description: 'Total deployment time in seconds',
          },
          downtime: {
            type: 'integer',
            description: 'Downtime in milliseconds',
            default: 0,
          },
        },
        required: ['id', 'configurationId', 'triggerType', 'dockerImage', 'status', 'currentState', 'startedAt', 'healthCheckPassed', 'downtime'],
      },
      TriggerDeploymentRequest: {
        type: 'object',
        properties: {
          applicationName: {
            type: 'string',
            description: 'Application name',
          },
          tag: {
            type: 'string',
            nullable: true,
            description: 'Docker image tag (optional)',
          },
          force: {
            type: 'boolean',
            default: false,
            description: 'Skip health checks',
          },
        },
        required: ['applicationName'],
      },
      HostnameValidationRequest: {
        type: 'object',
        properties: {
          hostname: {
            type: 'string',
            description: 'Hostname to validate',
          },
          excludeConfigId: {
            type: 'string',
            nullable: true,
            description: 'Configuration ID to exclude from conflict check',
          },
        },
        required: ['hostname'],
      },
      HostnameValidationResult: {
        type: 'object',
        properties: {
          isValid: {
            type: 'boolean',
            description: 'Whether the hostname format is valid',
          },
          isAvailable: {
            type: 'boolean',
            description: 'Whether the hostname is available',
          },
          message: {
            type: 'string',
            description: 'Validation message',
          },
          conflictDetails: {
            type: 'object',
            nullable: true,
            properties: {
              existsInCloudflare: { type: 'boolean' },
              existsInDeploymentConfigs: { type: 'boolean' },
              cloudflareZone: { type: 'string' },
              conflictingConfigId: { type: 'string' },
              conflictingConfigName: { type: 'string' },
            },
          },
          suggestions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Alternative hostname suggestions',
          },
        },
        required: ['isValid', 'isAvailable', 'message'],
      },
      // ====================
      // PostgreSQL Schemas
      // ====================
      DatabaseInfo: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Database name',
          },
          size: {
            type: 'string',
            nullable: true,
            description: 'Database size (human-readable)',
          },
          owner: {
            type: 'string',
            nullable: true,
            description: 'Database owner',
          },
          encoding: {
            type: 'string',
            nullable: true,
            description: 'Database encoding',
          },
        },
        required: ['name'],
      },
      PostgresDatabaseConfig: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Database configuration ID',
          },
          name: {
            type: 'string',
            description: 'Database configuration name',
          },
          host: {
            type: 'string',
            description: 'Database host',
          },
          port: {
            type: 'integer',
            minimum: 1,
            maximum: 65535,
            description: 'Database port',
          },
          database: {
            type: 'string',
            description: 'Database name',
          },
          username: {
            type: 'string',
            description: 'Database username',
          },
          sslMode: {
            type: 'string',
            enum: ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'],
            default: 'prefer',
            description: 'SSL mode',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Database tags',
          },
          lastHealthCheck: {
            type: 'string',
            format: 'date-time',
            nullable: true,
          },
          healthStatus: {
            type: 'string',
            enum: ['healthy', 'unhealthy', 'unknown'],
            default: 'unknown',
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
          },
          updatedAt: {
            type: 'string',
            format: 'date-time',
          },
        },
        required: ['id', 'name', 'host', 'port', 'database', 'username', 'createdAt', 'updatedAt'],
      },
      CreatePostgresDatabaseRequest: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
            description: 'Database configuration name',
          },
          host: {
            type: 'string',
            description: 'Database host',
          },
          port: {
            type: 'integer',
            minimum: 1,
            maximum: 65535,
            description: 'Database port',
          },
          database: {
            type: 'string',
            description: 'Database name',
          },
          username: {
            type: 'string',
            description: 'Database username',
          },
          password: {
            type: 'string',
            description: 'Database password',
          },
          sslMode: {
            type: 'string',
            enum: ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'],
            default: 'prefer',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Database tags',
          },
        },
        required: ['name', 'host', 'port', 'database', 'username', 'password'],
      },
      BackupConfigurationInfo: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Backup configuration ID',
          },
          databaseId: {
            type: 'string',
            description: 'Database configuration ID',
          },
          schedule: {
            type: 'string',
            nullable: true,
            description: 'Cron expression for scheduling',
          },
          timezone: {
            type: 'string',
            default: 'UTC',
            description: 'Timezone for schedule',
          },
          azureContainerName: {
            type: 'string',
            description: 'Azure Storage container name',
          },
          azurePathPrefix: {
            type: 'string',
            description: 'Azure Storage path prefix',
          },
          retentionDays: {
            type: 'integer',
            minimum: 1,
            maximum: 365,
            default: 30,
            description: 'Backup retention period in days',
          },
          backupFormat: {
            type: 'string',
            enum: ['custom', 'plain', 'directory'],
            default: 'custom',
            description: 'Backup format',
          },
          compressionLevel: {
            type: 'integer',
            minimum: 0,
            maximum: 9,
            default: 6,
            description: 'Compression level (0-9)',
          },
          isEnabled: {
            type: 'boolean',
            default: true,
            description: 'Whether backup is enabled',
          },
          lastBackupAt: {
            type: 'string',
            format: 'date-time',
            nullable: true,
          },
          nextScheduledAt: {
            type: 'string',
            format: 'date-time',
            nullable: true,
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
          },
          updatedAt: {
            type: 'string',
            format: 'date-time',
          },
        },
        required: ['id', 'databaseId', 'azureContainerName', 'azurePathPrefix', 'createdAt', 'updatedAt'],
      },
      // ====================
      // Environment Management Schemas
      // ====================
      EnvironmentInfo: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Environment unique identifier',
          },
          name: {
            type: 'string',
            description: 'Environment name',
          },
          description: {
            type: 'string',
            nullable: true,
            description: 'Environment description',
          },
          type: {
            type: 'string',
            enum: ['production', 'nonproduction'],
            description: 'Environment type',
          },
          networkType: {
            type: 'string',
            enum: ['local', 'internet'],
            default: 'local',
            description: 'Network type',
          },
          status: {
            type: 'string',
            enum: ['uninitialized', 'starting', 'running', 'stopping', 'stopped', 'failed'],
            default: 'uninitialized',
            description: 'Environment status',
          },
          isActive: {
            type: 'boolean',
            default: false,
            description: 'Whether environment is active',
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
          },
          updatedAt: {
            type: 'string',
            format: 'date-time',
          },
        },
        required: ['id', 'name', 'type', 'status', 'isActive', 'createdAt', 'updatedAt'],
      },
      CreateEnvironmentRequest: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
            description: 'Environment name',
          },
          description: {
            type: 'string',
            nullable: true,
            description: 'Environment description',
          },
          type: {
            type: 'string',
            enum: ['production', 'nonproduction'],
            description: 'Environment type',
          },
          networkType: {
            type: 'string',
            enum: ['local', 'internet'],
            default: 'local',
          },
        },
        required: ['name', 'type'],
      },
      // ====================
      // System Settings Schemas
      // ====================
      SystemSettingInfo: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'System setting ID',
          },
          category: {
            type: 'string',
            enum: ['docker', 'cloudflare', 'azure'],
            description: 'Setting category',
          },
          key: {
            type: 'string',
            description: 'Setting key',
          },
          value: {
            type: 'string',
            description: 'Setting value (may be encrypted)',
          },
          isEncrypted: {
            type: 'boolean',
            default: false,
            description: 'Whether the value is encrypted',
          },
          isActive: {
            type: 'boolean',
            default: true,
            description: 'Whether the setting is active',
          },
          lastValidatedAt: {
            type: 'string',
            format: 'date-time',
            nullable: true,
          },
          validationStatus: {
            type: 'string',
            enum: ['valid', 'invalid', 'pending', 'error'],
            nullable: true,
            description: 'Validation status',
          },
          validationMessage: {
            type: 'string',
            nullable: true,
            description: 'Validation message',
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
          },
          updatedAt: {
            type: 'string',
            format: 'date-time',
          },
        },
        required: ['id', 'category', 'key', 'value', 'createdAt', 'updatedAt'],
      },
      ConnectivityStatusInfo: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Connectivity status ID',
          },
          service: {
            type: 'string',
            enum: ['cloudflare', 'docker', 'azure'],
            description: 'Service name',
          },
          status: {
            type: 'string',
            enum: ['connected', 'failed', 'timeout', 'unreachable'],
            description: 'Connection status',
          },
          responseTimeMs: {
            type: 'integer',
            nullable: true,
            description: 'Response time in milliseconds',
          },
          errorMessage: {
            type: 'string',
            nullable: true,
            description: 'Error message for failed connections',
          },
          errorCode: {
            type: 'string',
            nullable: true,
            description: 'Service-specific error code',
          },
          lastSuccessfulAt: {
            type: 'string',
            format: 'date-time',
            nullable: true,
          },
          checkedAt: {
            type: 'string',
            format: 'date-time',
          },
          checkInitiatedBy: {
            type: 'string',
            nullable: true,
            description: 'User ID who initiated manual check',
          },
          metadata: {
            type: 'string',
            nullable: true,
            description: 'Additional service-specific metadata',
          },
        },
        required: ['id', 'service', 'status', 'checkedAt'],
      },
    },
  },
  security: [
    { BearerAuth: [] },
    { ApiKeyAuth: [] },
    { ApiKeyAuthBearer: [] },
  ],
};

const options = {
  definition: swaggerDefinition,
  apis: [
    './src/routes/*.ts',
    './src/app.ts',
  ],
};

const swaggerSpec = swaggerJsdoc(options);

export default swaggerSpec;