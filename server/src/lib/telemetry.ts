import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { BatchSpanProcessor, SpanProcessor } from "@opentelemetry/sdk-trace-node";
import { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ExportResult, ExportResultCode } from "@opentelemetry/core";
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
  debugEnabled: boolean;
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
    debugEnabled: process.env.OTEL_DEBUG === "true",
  };
}


// Debug trace exporter to log export data
class DebugTraceExporter {
  private enabled: boolean;
  private originalExporter: OTLPTraceExporter;

  constructor(originalExporter: OTLPTraceExporter, enabled: boolean) {
    this.originalExporter = originalExporter;
    this.enabled = enabled;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.enabled) {
      console.log('\n📤 OTEL DEBUG - Exporting Spans:', {
        spanCount: spans.length,
        endpoint: (this.originalExporter as any)._otlpExporter?.url,
        spans: spans.map(span => ({
          spanId: span.spanContext().spanId,
          traceId: span.spanContext().traceId,
          name: span.name,
          kind: span.kind,
          status: span.status,
          startTime: new Date(span.startTime[0] * 1000 + span.startTime[1] / 1000000).toISOString(),
          endTime: new Date(span.endTime[0] * 1000 + span.endTime[1] / 1000000).toISOString(),
          attributes: span.attributes,
          events: span.events?.length || 0,
          links: span.links?.length || 0,
        })),
      });
    }

    // Call the original exporter
    this.originalExporter.export(spans, (result: ExportResult) => {
      if (this.enabled) {
        console.log('\n✅ OTEL DEBUG - Export Result:', {
          code: result.code,
          error: result.error?.message,
          success: result.code === ExportResultCode.SUCCESS,
          spanCount: spans.length,
        });
      }
      resultCallback(result);
    });
  }

  shutdown(): Promise<void> {
    return this.originalExporter.shutdown();
  }
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

  // Check if SDK was already initialized in bootstrap
  if ((global as any).__otelSDK) {
    logger.info("OpenTelemetry SDK already initialized in bootstrap, reusing...");
    sdk = (global as any).__otelSDK;

    logger.info({
      serviceName: config.serviceName,
      serviceVersion: config.serviceVersion,
      endpoint: config.endpoint,
      samplingRatio: config.samplingRatio,
      debugEnabled: config.debugEnabled,
    }, "OpenTelemetry initialized successfully (bootstrap)");

    if (config.debugEnabled) {
      console.log('\n🚀 OTEL DEBUG MODE ENABLED (BOOTSTRAP)');
      console.log('📋 Configuration:', {
        serviceName: config.serviceName,
        serviceVersion: config.serviceVersion,
        endpoint: config.endpoint,
        headers: Object.keys(config.headers || {}),
        resourceAttributes: config.resourceAttributes,
        samplingRatio: config.samplingRatio,
      });
      console.log('💡 All OpenTelemetry spans and exports will be logged to console');
    }
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

    // Wrap exporter with debug logger if debug is enabled
    const debugExporter = new DebugTraceExporter(traceExporter, config.debugEnabled);

    // Create span processor with batching for performance
    const spanProcessor = new BatchSpanProcessor(debugExporter as any, {
      maxQueueSize: 1000,
      maxExportBatchSize: 100,
      exportTimeoutMillis: 30000,
      scheduledDelayMillis: 5000,
    });

    // Use auto-instrumentations with custom hooks
    const instrumentations = [
      // Use auto-instrumentations with debug logging
      ...getNodeAutoInstrumentations({
        // Enable HTTP instrumentation with custom debug hooks
        "@opentelemetry/instrumentation-http": {
          enabled: true,
          requestHook: (span, request) => {
            if (config.debugEnabled) {
              console.log(`🌐 HTTP Request: ${(request as any).method} ${(request as any).url}`);
            }
          },
          responseHook: (span, response) => {
            if (config.debugEnabled) {
              console.log(`📡 HTTP Response: ${(response as any).statusCode}`);
            }
          }
        },
        // Enable Express instrumentation with custom debug hooks
        "@opentelemetry/instrumentation-express": {
          enabled: true,
          requestHook: (span, info) => {
            if (config.debugEnabled) {
              console.log(`🚀 Express Request: ${info.request.method} ${info.request.url}`);
            }
          }
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
      })
    ];

    // Initialize the SDK with span processor
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
      debugEnabled: config.debugEnabled,
    }, "OpenTelemetry initialized successfully");

    if (config.debugEnabled) {
      console.log('\n🚀 OTEL DEBUG MODE ENABLED');
      console.log('📋 Configuration:', {
        serviceName: config.serviceName,
        serviceVersion: config.serviceVersion,
        endpoint: config.endpoint,
        headers: Object.keys(config.headers || {}),
        resourceAttributes: config.resourceAttributes,
        samplingRatio: config.samplingRatio,
      });
      console.log('💡 All OpenTelemetry spans and exports will be logged to console');
    }

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

// Enable/disable debug mode at runtime
export function setDebugMode(enabled: boolean): void {
  const config = getTelemetryConfig();
  process.env.OTEL_DEBUG = enabled ? "true" : "false";

  if (enabled) {
    console.log('\n🚀 OTEL DEBUG MODE ENABLED AT RUNTIME');
    console.log('💡 All new OpenTelemetry spans will be logged to console');
  } else {
    console.log('\n🔇 OTEL DEBUG MODE DISABLED AT RUNTIME');
  }
}