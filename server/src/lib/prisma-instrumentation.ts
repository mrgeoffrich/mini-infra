import { trace, SpanStatusCode, SpanKind } from "@opentelemetry/api";
import { PrismaClient } from "@prisma/client";

// Tracer for Prisma operations
const tracer = trace.getTracer("mini-infra-prisma", "1.0.0");

// Enhanced Prisma client with OpenTelemetry instrumentation
export function instrumentPrismaClient(prisma: PrismaClient): PrismaClient {
  // Use Prisma middleware to add tracing if available
  if (typeof (prisma as any).$use === 'function') {
    (prisma as any).$use(async (params: any, next: any) => {
    const spanName = `prisma.${params.model || "unknown"}.${params.action}`;

    return tracer.startActiveSpan(
      spanName,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "db.system": "sqlite",
          "db.operation": params.action,
          "db.sql.table": params.model || "unknown",
          "component": "prisma",
        },
      },
      async (span) => {
        try {
          // Add query-specific attributes if available
          if (params.args) {
            // Don't log sensitive data, just the structure
            span.setAttributes({
              "db.prisma.args_count": Object.keys(params.args).length,
              "db.prisma.has_where": "where" in params.args,
              "db.prisma.has_select": "select" in params.args,
              "db.prisma.has_include": "include" in params.args,
            });
          }

          const startTime = Date.now();
          const result = await next(params);
          const duration = Date.now() - startTime;

          // Add result metadata (without sensitive data)
          span.setAttributes({
            "db.operation.duration_ms": duration,
            "db.operation.success": true,
          });

          // For queries that return arrays, add count
          if (Array.isArray(result)) {
            span.setAttributes({
              "db.result.count": result.length,
            });
          }

          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : "Unknown error",
          });
          throw error;
        } finally {
          span.end();
        }
      }
    );
    });
  }

  return prisma;
}

// Helper function to create a span for a custom database operation
export function createDatabaseSpan<T>(
  operationName: string,
  operation: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  return tracer.startActiveSpan(
    `db.${operationName}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "db.system": "sqlite",
        "component": "prisma",
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

        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : "Unknown error",
        });
        throw error;
      } finally {
        span.end();
      }
    }
  );
}