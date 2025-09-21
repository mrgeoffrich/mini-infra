import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { appLogger } from "./logger-factory";

// Create logger instance for telemetry
const logger = appLogger();

// OpenTelemetry configuration interface
export interface TelemetryConfig {
  serviceName: string;
  serviceVersion: string;
  endpoint?: string;
  headers?: Record<string, string>;
  resourceAttributes?: Record<string, string>;
  samplingRatio?: number;
  enabled: boolean;
}

// Get telemetry configuration from environment variables
function getTelemetryConfig(): TelemetryConfig {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const headersString = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  const resourceAttributesString = process.env.OTEL_RESOURCE_ATTRIBUTES;

  // Parse headers if provided (format: key1=value1,key2=value2)
  let headers: Record<string, string> = {};
  if (headersString) {
    try {
      headers = headersString.split(',').reduce((acc, pair) => {
        const [key, value] = pair.split('=');
        if (key && value) {
          acc[key.trim()] = value.trim();
        }
        return acc;
      }, {} as Record<string, string>);
    } catch (error) {
      logger.warn({ error }, "Failed to parse OTEL_EXPORTER_OTLP_HEADERS");
    }
  }

  // Parse resource attributes if provided (format: key1=value1,key2=value2)
  let resourceAttributes: Record<string, string> = {};
  if (resourceAttributesString) {
    try {
      resourceAttributes = resourceAttributesString.split(',').reduce((acc, pair) => {
        const [key, value] = pair.split('=');
        if (key && value) {
          acc[key.trim()] = value.trim();
        }
        return acc;
      }, {} as Record<string, string>);
    } catch (error) {
      logger.warn({ error }, "Failed to parse OTEL_RESOURCE_ATTRIBUTES");
    }
  }

  return {
    serviceName: process.env.OTEL_SERVICE_NAME || "mini-infra",
    serviceVersion: process.env.OTEL_SERVICE_VERSION || "0.1.0",
    endpoint,
    headers,
    resourceAttributes,
    samplingRatio: process.env.OTEL_SAMPLING_RATIO ? parseFloat(process.env.OTEL_SAMPLING_RATIO) : 1.0,
    enabled: process.env.OTEL_ENABLED !== "false" && !!endpoint,
  };
}

// Global SDK instance
let sdk: NodeSDK | null = null;

// Initialize OpenTelemetry
export function initializeTelemetry(): void {
  const config = getTelemetryConfig();

  if (!config.enabled) {
    logger.info("OpenTelemetry is disabled or no endpoint configured");
    return;
  }

  try {
    // Create resource with service information
    const resource = resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]: config.serviceName,
      [SEMRESATTRS_SERVICE_VERSION]: config.serviceVersion,
      "service.environment": process.env.NODE_ENV || "development",
      "service.instance.id": process.env.HOSTNAME || `${config.serviceName}-${process.pid}`,
      ...config.resourceAttributes,
    });

    // Create OTLP trace exporter
    const traceExporter = new OTLPTraceExporter({
      url: config.endpoint,
      headers: config.headers,
    });

    // Create span processor with batching for performance
    const spanProcessor = new BatchSpanProcessor(traceExporter, {
      maxQueueSize: 1000,
      maxExportBatchSize: 100,
      exportTimeoutMillis: 30000,
      scheduledDelayMillis: 5000,
    });

    // Configure auto-instrumentations
    const instrumentations = getNodeAutoInstrumentations({
      // Enable Express instrumentation
      "@opentelemetry/instrumentation-express": {
        enabled: true,
        requestHook: (span, info) => {
          // Add custom attributes to HTTP spans
          span.setAttributes({
            "http.request.body.size": info.request.headers["content-length"] || 0,
            "http.user_agent": info.request.headers["user-agent"] || "",
          });
        },
      },
      // Enable HTTP instrumentation for outgoing requests
      "@opentelemetry/instrumentation-http": {
        enabled: true,
        requestHook: (span, request) => {
          // Add custom attributes for outgoing HTTP requests
          if (request && typeof request === "object") {
            const url = (request as any).url || (request as any).href || "";
            span.setAttributes({
              "http.client.request.url": url,
            });
          }
        },
      },
      // Enable Pino instrumentation for log correlation
      "@opentelemetry/instrumentation-pino": {
        enabled: true,
        logHook: (span, record) => {
          // Add trace context to log records
          record["trace_id"] = span.spanContext().traceId;
          record["span_id"] = span.spanContext().spanId;
        },
      },
      // Disable file system instrumentation to reduce noise
      "@opentelemetry/instrumentation-fs": {
        enabled: false,
      },
      // Disable DNS instrumentation to reduce noise
      "@opentelemetry/instrumentation-dns": {
        enabled: false,
      },
    });

    // Initialize the SDK
    sdk = new NodeSDK({
      resource,
      spanProcessor,
      instrumentations,
    });

    // Start the SDK
    sdk.start();

    logger.info({
      serviceName: config.serviceName,
      serviceVersion: config.serviceVersion,
      endpoint: config.endpoint,
      samplingRatio: config.samplingRatio,
    }, "OpenTelemetry initialized successfully");

  } catch (error) {
    logger.error({ error }, "Failed to initialize OpenTelemetry");
    // Don't throw - let the application continue without telemetry
  }
}

// Shutdown telemetry gracefully
export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    try {
      await sdk.shutdown();
      logger.info("OpenTelemetry SDK shutdown completed");
    } catch (error) {
      logger.error({ error }, "Error during OpenTelemetry shutdown");
    }
  }
}

// Export current configuration for diagnostics
export function getTelemetryStatus(): TelemetryConfig & { initialized: boolean } {
  return {
    ...getTelemetryConfig(),
    initialized: sdk !== null,
  };
}