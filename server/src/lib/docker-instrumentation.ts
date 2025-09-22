import { trace, SpanStatusCode, SpanKind } from "@opentelemetry/api";

// Tracer for Docker operations
const tracer = trace.getTracer("mini-infra-docker", "1.0.0");

// Helper function to create a span for Docker operations
export function createDockerSpan<T>(
  operationName: string,
  operation: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return tracer.startActiveSpan(
    `docker.${operationName}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "component": "dockerode",
        "docker.operation": operationName,
        ...attributes,
      },
    },
    async (span) => {
      try {
        const startTime = Date.now();
        const result = await operation();
        const duration = Date.now() - startTime;

        span.setAttributes({
          "docker.operation.duration_ms": duration,
          "docker.operation.success": true,
        });

        // Add result metadata (without sensitive data)
        if (Array.isArray(result)) {
          span.setAttributes({
            "docker.result.count": result.length,
          });
        } else if (result && typeof result === "object") {
          // For container objects, add basic metadata
          if ("Id" in result) {
            span.setAttributes({
              "docker.container.id": String(result.Id).substring(0, 12), // Short ID
            });
          }
          if ("State" in result) {
            span.setAttributes({
              "docker.container.state": String(result.State),
            });
          }
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown Docker error",
        });

        // Add error-specific attributes
        if (error instanceof Error) {
          span.setAttributes({
            "docker.error.name": error.name,
            "docker.error.code": (error as any).statusCode || (error as any).code || "unknown",
          });
        }

        throw error;
      } finally {
        span.end();
      }
    }
  );
}

// Helper function for Docker container-specific operations
export function createContainerSpan<T>(
  operationName: string,
  containerId: string,
  operation: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return createDockerSpan(
    `container.${operationName}`,
    operation,
    {
      "docker.container.id": containerId.substring(0, 12), // Short ID for readability
      ...attributes,
    }
  );
}

// Helper function for Docker image-specific operations
export function createImageSpan<T>(
  operationName: string,
  imageId: string,
  operation: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return createDockerSpan(
    `image.${operationName}`,
    operation,
    {
      "docker.image.id": imageId,
      ...attributes,
    }
  );
}

// Helper function for Docker network operations
export function createNetworkSpan<T>(
  operationName: string,
  operation: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return createDockerSpan(
    `network.${operationName}`,
    operation,
    {
      "docker.resource.type": "network",
      ...attributes,
    }
  );
}

// Helper function for Docker volume operations
export function createVolumeSpan<T>(
  operationName: string,
  operation: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return createDockerSpan(
    `volume.${operationName}`,
    operation,
    {
      "docker.resource.type": "volume",
      ...attributes,
    }
  );
}