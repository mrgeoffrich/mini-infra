import { useState, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  SettingsCategory,
  TestServiceResponse,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Test Service API Function
// ====================

async function testService(
  service: SettingsCategory,
  settings: Record<string, string>,
  correlationId?: string,
): Promise<TestServiceResponse> {
  const response = await fetch(`/api/settings/test/${service}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(correlationId && { "X-Correlation-ID": correlationId }),
    },
    body: JSON.stringify({ settings }),
  });

  if (!response.ok) {
    throw new Error(`Failed to test ${service}: ${response.statusText}`);
  }

  const data: TestServiceResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || `Failed to test ${service}`);
  }

  return data;
}

// ====================
// Test Result Types
// ====================

export interface TestResult {
  service: SettingsCategory;
  isValid: boolean;
  responseTimeMs: number;
  error?: string;
  errorCode?: string;
  metadata?: Record<string, any>;
  testedAt: string;
}

// ====================
// Service Testing Hook Options
// ====================

export interface UseServiceTestingOptions {
  onSuccess?: (result: TestResult) => void;
  onError?: (error: Error) => void;
}

// ====================
// Service Testing Hook
// ====================

export function useServiceTesting(
  service: SettingsCategory,
  options: UseServiceTestingOptions = {}
) {
  const [testResults, setTestResults] = useState<TestResult | null>(null);
  const correlationId = generateCorrelationId();

  const testMutation = useMutation({
    mutationFn: (settings: Record<string, string>) =>
      testService(service, settings, correlationId),
    onSuccess: (data) => {
      const result: TestResult = {
        service: data.data.service,
        isValid: data.data.isValid,
        responseTimeMs: data.data.responseTimeMs,
        error: data.data.error,
        errorCode: data.data.errorCode,
        metadata: data.data.metadata,
        testedAt: data.data.testedAt,
      };

      setTestResults(result);
      options.onSuccess?.(result);
    },
    onError: (error) => {
      // Create a failed test result for consistent UI state
      const failedResult: TestResult = {
        service,
        isValid: false,
        responseTimeMs: 0,
        error: error instanceof Error ? error.message : "Unknown test error",
        errorCode: "TEST_ERROR",
        testedAt: new Date().toISOString(),
      };

      setTestResults(failedResult);
      options.onError?.(error as Error);
    },
  });

  const testConnection = useCallback(
    async (settings: Record<string, string>) => {
      try {
        const result = await testMutation.mutateAsync(settings);
        return result;
      } catch (error) {
        throw error;
      }
    },
    [testMutation]
  );

  const clearTestResults = useCallback(() => {
    setTestResults(null);
  }, []);

  const hasTestResults = testResults !== null;
  const isTestingSuccessful = testResults?.isValid === true;
  const isTestingFailed = testResults?.isValid === false;

  return {
    // Test results state
    testResults,
    hasTestResults,
    isTestingSuccessful,
    isTestingFailed,

    // Test execution state
    isTesting: testMutation.isPending,
    testError: testMutation.error,

    // Actions
    testConnection,
    clearTestResults,

    // Raw mutation for advanced usage
    testMutation,
  };
}

// ====================
// Helper Hook for Form Integration
// ====================

export interface UseFormTestingOptions extends UseServiceTestingOptions {
  clearOnFormChange?: boolean;
}

export function useFormTesting(
  service: SettingsCategory,
  formValues: Record<string, string>,
  options: UseFormTestingOptions = {}
) {
  const { clearOnFormChange = true, ...serviceTestingOptions } = options;

  const serviceTestingHook = useServiceTesting(service, serviceTestingOptions);

  // Clear test results when form values change (if enabled)
  useState(() => {
    if (clearOnFormChange) {
      serviceTestingHook.clearTestResults();
    }
  });

  const testCurrentFormValues = useCallback(async () => {
    return serviceTestingHook.testConnection(formValues);
  }, [serviceTestingHook, formValues]);

  return {
    ...serviceTestingHook,
    testCurrentFormValues,
  };
}

// ====================
// Type Exports
// ====================

export type { TestServiceResponse };