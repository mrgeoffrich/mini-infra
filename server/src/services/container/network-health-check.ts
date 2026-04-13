import { servicesLogger, dockerExecutorLogger } from "../../lib/logger-factory";
import { DockerExecutorService } from "../docker-executor";
import prisma from "../../lib/prisma";
import {
  HealthCheckConfig,
  ValidationResult,
} from "@mini-infra/types";

// Import HealthCheckResult from local health-check service
export interface HealthCheckResult {
  success: boolean;
  statusCode?: number;
  responseTime: number;
  responseBody?: unknown;
  errorMessage?: string;
  validationDetails?: {
    statusCode: boolean;
    bodyPattern: boolean;
    responseTime: boolean;
    networkConnectivity: boolean;
  };
}

/**
 * Network health check configuration interface
 */
export interface NetworkHealthCheckConfig {
  containerName: string;
  containerPort: number;
  endpoint: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  expectedStatuses?: number[];
  responseBodyPattern?: string; // regex pattern
  responseTimeThreshold?: number; // milliseconds
  curlImage?: string; // Optional custom curl image
}

/**
 * Parsed curl output interface
 */
interface CurlResult {
  statusCode: number;
  responseTime: number; // in seconds
  responseBody: string;
  stderr: string;
  success: boolean;
  errorMessage?: string;
}

/**
 * NetworkHealthCheckService provides container-network-aware health checking using curl containers.
 * This service runs curl containers attached to the same Docker network as target containers,
 * enabling health checks for containers that are not accessible from the host network.
 */
export class NetworkHealthCheckService {
  private static readonly DEFAULT_TIMEOUT = 10000; // 10 seconds
  private static readonly DEFAULT_RETRIES = 3;
  private static readonly DEFAULT_RETRY_DELAY = 1000; // 1 second
  private static readonly DEFAULT_EXPECTED_STATUSES = [200, 201, 202, 204];
  private static readonly DEFAULT_CURL_IMAGE = "curlimages/curl:latest";
  private static readonly RESPONSE_TIME_THRESHOLD = 30000; // 30 seconds

  private dockerExecutor: DockerExecutorService;

  constructor() {
    this.dockerExecutor = new DockerExecutorService();
  }

  /**
   * Initialize the network health check service
   */
  async initialize(): Promise<void> {
    await this.dockerExecutor.initialize();
  }


  /**
   * Get curl image from system settings or use default
   */
  private async getCurlImage(): Promise<string> {
    try {
      const curlImageSetting = await prisma.systemSettings.findFirst({
        where: {
          category: "system",
          key: "curl_image",
        },
      });

      const curlImage = curlImageSetting?.value || NetworkHealthCheckService.DEFAULT_CURL_IMAGE;

      servicesLogger().debug(
        {
          curlImage,
          fromSettings: !!curlImageSetting?.value,
        },
        "Retrieved curl image for health checks",
      );

      return curlImage;
    } catch (error) {
      servicesLogger().warn(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Failed to get curl image from settings, using default",
      );
      return NetworkHealthCheckService.DEFAULT_CURL_IMAGE;
    }
  }

  /**
   * Build curl command for health check
   */
  private buildCurlCommand(config: NetworkHealthCheckConfig): string[] {
    const url = `http://${config.containerName}:${config.containerPort}${config.endpoint}`;
    const timeout = Math.floor((config.timeout || NetworkHealthCheckService.DEFAULT_TIMEOUT) / 1000);

    const curlArgs = [
      "curl",
      "-s", // Silent mode
      "-w", "STATUS_CODE:%{http_code}\\nTIME_TOTAL:%{time_total}\\n", // Output format
      "--max-time", timeout.toString(), // Total timeout
      "--connect-timeout", "10", // Connection timeout
    ];

    // Add HTTP method if specified
    if (config.method && config.method !== "GET") {
      curlArgs.push("-X", config.method);
    }

    // Add headers if specified
    if (config.headers) {
      Object.entries(config.headers).forEach(([key, value]) => {
        curlArgs.push("-H", `${key}: ${value}`);
      });
    }

    // Add URL as final argument
    curlArgs.push(url);

    return curlArgs;
  }

  /**
   * Parse curl output to extract health check results
   */
  private parseCurlOutput(stdout: string, stderr: string): CurlResult {
    try {
      // Split stdout into lines
      const lines = stdout.split('\n');
      
      // Find status code and timing lines (they're at the end)
      let statusCode = 0;
      let responseTime = 0;
      let responseBody = '';
      
      const statusCodeMatch = stdout.match(/STATUS_CODE:(\d+)/);
      const timeMatch = stdout.match(/TIME_TOTAL:([\d.]+)/);
      
      if (statusCodeMatch) {
        statusCode = parseInt(statusCodeMatch[1]);
      }
      
      if (timeMatch) {
        responseTime = parseFloat(timeMatch[1]);
      }
      
      // Extract response body (everything before the STATUS_CODE line)
      const statusCodeIndex = lines.findIndex(line => line.includes('STATUS_CODE:'));
      if (statusCodeIndex > 0) {
        responseBody = lines.slice(0, statusCodeIndex).join('\n').trim();
      }

      const success = statusCode > 0 && stderr.length === 0;

      return {
        statusCode,
        responseTime,
        responseBody,
        stderr,
        success,
        errorMessage: stderr || (!success ? `Invalid status code: ${statusCode}` : undefined),
      };
    } catch (error) {
      dockerExecutorLogger().error(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          stdout: stdout.substring(0, 500), // Limit log size
          stderr: stderr.substring(0, 500),
        },
        "Failed to parse curl output",
      );

      return {
        statusCode: 0,
        responseTime: 0,
        responseBody: '',
        stderr: stderr || "Failed to parse curl output",
        success: false,
        errorMessage: "Failed to parse curl output",
      };
    }
  }

  /**
   * Validate response body against pattern
   */
  private validateResponseBody(body: string, pattern?: string): boolean {
    if (!pattern) return true;

    try {
      const regex = new RegExp(pattern);
      return regex.test(body);
    } catch (error) {
      servicesLogger().warn(
        {
          pattern,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Invalid regex pattern for response body validation",
      );
      return false;
    }
  }

  /**
   * Perform single network health check using curl container
   */
  private async performSingleNetworkHealthCheck(
    config: NetworkHealthCheckConfig,
  ): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const dockerNetworkName = await this.dockerExecutor.getDockerNetworkName();
      const curlImage = config.curlImage || (await this.getCurlImage());
      const curlCommand = this.buildCurlCommand(config);
      const healthCheckUrl = `http://${config.containerName}:${config.containerPort}${config.endpoint}`;

      dockerExecutorLogger().info(
        {
          containerName: config.containerName,
          containerPort: config.containerPort,
          endpoint: config.endpoint,
          dockerNetwork: dockerNetworkName,
          healthCheckUrl,
          curlImage,
          curlCommand,
        },
        "Performing network health check using curl container",
      );

      // Execute curl container on the same Docker network
      const executionResult = await this.dockerExecutor.executeContainer({
        image: curlImage,
        cmd: curlCommand,
        env: {}, // No environment variables needed for curl
        timeout: (config.timeout || NetworkHealthCheckService.DEFAULT_TIMEOUT) + 5000, // Add 5s buffer for container overhead
        removeContainer: true,
        networkMode: dockerNetworkName,
      });

      const responseTime = Date.now() - startTime;
      
      // Log container output to dockerExecutorLogger
      if (executionResult.stdout) {
        dockerExecutorLogger().debug(
          {
            containerName: config.containerName,
            curlImage,
            stdout: executionResult.stdout,
          },
          "Network health check container stdout",
        );
      }
      
      if (executionResult.stderr) {
        dockerExecutorLogger().debug(
          {
            containerName: config.containerName,
            curlImage,
            stderr: executionResult.stderr,
          },
          "Network health check container stderr",
        );
      }
      
      // Parse curl output
      const curlResult = this.parseCurlOutput(executionResult.stdout, executionResult.stderr);
      
      // Use curl result or fall back to execution result
      const actualResponseTime = curlResult.responseTime > 0 ? curlResult.responseTime * 1000 : responseTime;
      const statusCode = curlResult.statusCode || (executionResult.exitCode === 0 ? 200 : 0);
      const responseBody = curlResult.responseBody || executionResult.stdout;
      const errorMessage = curlResult.errorMessage || executionResult.stderr;

      const expectedStatuses = config.expectedStatuses || NetworkHealthCheckService.DEFAULT_EXPECTED_STATUSES;

      // Validation checks
      const validationDetails = {
        statusCode: expectedStatuses.includes(statusCode),
        bodyPattern: this.validateResponseBody(responseBody, config.responseBodyPattern),
        responseTime: !config.responseTimeThreshold || actualResponseTime <= config.responseTimeThreshold,
        networkConnectivity: executionResult.exitCode === 0 && curlResult.success,
      };

      const success = Object.values(validationDetails).every(Boolean);

      const healthResult: HealthCheckResult = {
        success,
        statusCode,
        responseTime: actualResponseTime,
        responseBody,
        validationDetails,
      };

      if (!success) {
        const failedChecks = Object.entries(validationDetails)
          .filter(([_, passed]) => !passed)
          .map(([check]) => check);

        healthResult.errorMessage = `Network health check failed validation: ${failedChecks.join(", ")}. ${errorMessage}`.trim();
      }

      dockerExecutorLogger().debug(
        {
          containerName: config.containerName,
          statusCode,
          responseTime: actualResponseTime,
          success,
          validationDetails,
          curlExitCode: executionResult.exitCode,
        },
        "Network health check completed",
      );

      return healthResult;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      dockerExecutorLogger().error(
        {
          containerName: config.containerName,
          endpoint: config.endpoint,
          error: errorMessage,
          responseTime,
        },
        "Network health check failed with error",
      );

      return {
        success: false,
        responseTime,
        errorMessage: `Network health check failed: ${errorMessage}`,
      };
    }
  }

  /**
   * Perform network health check with retry logic
   */
  async performNetworkHealthCheck(
    config: NetworkHealthCheckConfig,
  ): Promise<HealthCheckResult> {
    const retries = config.retries ?? NetworkHealthCheckService.DEFAULT_RETRIES;
    const baseDelay = config.retryDelay ?? NetworkHealthCheckService.DEFAULT_RETRY_DELAY;
    let lastResult: HealthCheckResult | null = null;

    servicesLogger().info(
      {
        containerName: config.containerName,
        endpoint: config.endpoint,
        retries: retries + 1, // Total attempts including first try
      },
      "Starting network health check with retry logic",
    );

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: baseDelay * 2^(attempt-1)
        const delay = baseDelay * Math.pow(2, attempt - 1);
        servicesLogger().debug(
          {
            containerName: config.containerName,
            attempt,
            totalAttempts: retries + 1,
            retryDelay: delay,
          },
          "Retrying network health check after delay",
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const result = await this.performSingleNetworkHealthCheck(config);
      lastResult = result;

      if (result.success) {
        servicesLogger().info(
          {
            containerName: config.containerName,
            attempt: attempt + 1,
            totalAttempts: retries + 1,
            responseTime: result.responseTime,
            statusCode: result.statusCode,
          },
          "Network health check succeeded",
        );
        return result;
      }

      servicesLogger().debug(
        {
          containerName: config.containerName,
          attempt: attempt + 1,
          totalAttempts: retries + 1,
          error: result.errorMessage,
          willRetry: attempt < retries,
        },
        "Network health check attempt failed",
      );
    }

    // All attempts failed
    servicesLogger().warn(
      {
        containerName: config.containerName,
        endpoint: config.endpoint,
        totalAttempts: retries + 1,
        finalError: lastResult?.errorMessage,
      },
      "Network health check failed after all retry attempts",
    );

    return lastResult!;
  }

  /**
   * Perform basic network health check (GET request, 200 status only)
   */
  async performBasicNetworkHealthCheck(
    containerName: string,
    containerPort: number,
    endpoint: string,
  ): Promise<HealthCheckResult> {
    return this.performNetworkHealthCheck({
      containerName,
      containerPort,
      endpoint,
      method: "GET",
      expectedStatuses: [200],
      timeout: 5000, // Shorter timeout for basic checks
      retries: 1,
    });
  }

  /**
   * Convert standard HealthCheckConfig to NetworkHealthCheckConfig
   */
  convertHealthCheckConfig(
    containerName: string,
    containerPort: number,
    config: HealthCheckConfig,
  ): NetworkHealthCheckConfig {
    return {
      containerName,
      containerPort,
      endpoint: config.endpoint,
      method: config.method,
      timeout: config.timeout,
      retries: config.retries,
      retryDelay: config.interval,
      expectedStatuses: config.expectedStatus,
      responseBodyPattern: config.responseValidation,
      responseTimeThreshold: NetworkHealthCheckService.RESPONSE_TIME_THRESHOLD,
    };
  }

  /**
   * Convert health check result to validation result format
   */
  convertToValidationResult(
    result: HealthCheckResult,
    containerName: string,
    endpoint: string,
  ): ValidationResult {
    return {
      isValid: result.success,
      message: result.success
        ? `Network health check passed for ${containerName}:${endpoint}`
        : result.errorMessage || `Network health check failed for ${containerName}:${endpoint}`,
      errorCode: result.success ? undefined : "NETWORK_HEALTH_CHECK_FAILED",
      responseTimeMs: result.responseTime,
      metadata: {
        containerName,
        endpoint,
        statusCode: result.statusCode,
        validationDetails: result.validationDetails,
      },
    };
  }
}