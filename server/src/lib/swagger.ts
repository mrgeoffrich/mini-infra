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
    schemas: {
      // Common response schemas
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
          details: {
            description: 'Additional error details (optional)',
          },
        },
        required: ['success', 'error'],
      },
      HealthResponse: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
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
        },
        required: ['status', 'timestamp', 'environment', 'uptime'],
      },
      // Container schemas
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
                type: { type: 'string' },
              },
            },
          },
        },
      },
      // Deployment schemas
      DeploymentConfigInfo: {
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
          port: {
            type: 'number',
            description: 'Application port',
          },
          hostname: {
            type: 'string',
            description: 'Hostname for the application',
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
      },
      // PostgreSQL schemas
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