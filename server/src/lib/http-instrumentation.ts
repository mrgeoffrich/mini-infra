import { trace, SpanStatusCode, SpanKind } from "@opentelemetry/api";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";

// Tracer for HTTP client operations
const tracer = trace.getTracer("mini-infra-http-client", "1.0.0");

// Helper function to create a span for external API calls
export function createHttpSpan<T>(
  serviceName: string,
  operationName: string,
  operation: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return tracer.startActiveSpan(
    `http.${serviceName}.${operationName}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "component": "http-client",
        "http.service": serviceName,
        "http.operation": operationName,
        ...attributes,
      },
    },
    async (span) => {
      try {
        const startTime = Date.now();
        const result = await operation();
        const duration = Date.now() - startTime;

        span.setAttributes({
          "http.operation.duration_ms": duration,
          "http.operation.success": true,
        });

        // Add response metadata if available
        if (result && typeof result === "object") {
          if ("status" in result) {
            span.setAttributes({
              "http.response.status_code": Number(result.status),
            });
          }
          if ("statusText" in result) {
            span.setAttributes({
              "http.response.status_text": String(result.statusText),
            });
          }
          if ("data" in result && Array.isArray(result.data)) {
            span.setAttributes({
              "http.response.data.count": result.data.length,
            });
          }
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown HTTP error",
        });

        // Add error-specific attributes
        if (error instanceof Error) {
          span.setAttributes({
            "http.error.name": error.name,
          });

          // Add HTTP error details if available
          if ("response" in error && error.response) {
            const response = error.response as AxiosResponse;
            span.setAttributes({
              "http.error.status_code": response.status,
              "http.error.status_text": response.statusText,
            });
          }

          if ("code" in error) {
            span.setAttributes({
              "http.error.code": String(error.code),
            });
          }
        }

        throw error;
      } finally {
        span.end();
      }
    }
  );
}

// Helper function specifically for Azure Storage operations
export function createAzureSpan<T>(
  operationName: string,
  operation: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return createHttpSpan(
    "azure-storage",
    operationName,
    operation,
    {
      "cloud.provider": "azure",
      "cloud.service": "storage",
      ...attributes,
    }
  );
}

// Helper function specifically for Cloudflare API operations
export function createCloudflareSpan<T>(
  operationName: string,
  operation: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return createHttpSpan(
    "cloudflare",
    operationName,
    operation,
    {
      "cloud.provider": "cloudflare",
      "cloud.service": "api",
      ...attributes,
    }
  );
}

// Helper function for PostgreSQL client operations
export function createPostgresSpan<T>(
  operationName: string,
  operation: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return tracer.startActiveSpan(
    `postgres.${operationName}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "component": "pg-client",
        "db.system": "postgresql",
        "db.operation": operationName,
        ...attributes,
      },
    },
    async (span) => {
      try {
        const startTime = Date.now();
        const result = await operation();
        const duration = Date.now() - startTime;

        span.setAttributes({
          "db.operation.duration_ms": duration,
          "db.operation.success": true,
        });

        // Add result metadata for queries
        if (result && typeof result === "object") {
          if ("rows" in result && Array.isArray(result.rows)) {
            span.setAttributes({
              "db.result.rows": result.rows.length,
            });
          }
          if ("rowCount" in result) {
            span.setAttributes({
              "db.result.affected_rows": Number(result.rowCount),
            });
          }
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown PostgreSQL error",
        });

        // Add PostgreSQL error details
        if (error instanceof Error) {
          span.setAttributes({
            "db.error.name": error.name,
          });

          if ("code" in error) {
            span.setAttributes({
              "db.error.code": String(error.code),
            });
          }

          if ("severity" in error) {
            span.setAttributes({
              "db.error.severity": String(error.severity),
            });
          }
        }

        throw error;
      } finally {
        span.end();
      }
    }
  );
}