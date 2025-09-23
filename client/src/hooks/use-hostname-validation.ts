import { useMutation } from "@tanstack/react-query";
import React, { useState, useCallback } from "react";
import {
  HostnameValidationRequest,
  HostnameValidationResponse,
  HostnameValidationResult,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `hostname-validation-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Hostname Validation API Functions
// ====================

async function validateHostname(
  hostname: string,
  correlationId: string,
  excludeConfigId?: string,
): Promise<HostnameValidationResult> {
  const url = `/api/deployments/configs/validate-hostname`;

  const requestData: HostnameValidationRequest = {
    hostname,
    ...(excludeConfigId && { excludeConfigId }),
  };

  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(requestData),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to validate hostname: ${response.status} ${errorText}`);
  }

  const result: HostnameValidationResponse = await response.json();

  if (!result.success) {
    throw new Error(result.message || "Hostname validation failed");
  }

  return result.data;
}

// ====================
// React Hooks
// ====================

/**
 * Hook for validating hostname availability
 * Returns mutation object with hostname validation state
 */
export function useHostnameValidation() {
  const [lastValidatedHostname, setLastValidatedHostname] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async ({ hostname, excludeConfigId }: { hostname: string; excludeConfigId?: string }) => {
      const correlationId = generateCorrelationId();
      const result = await validateHostname(hostname, correlationId, excludeConfigId);
      setLastValidatedHostname(hostname);
      return result;
    },
    onError: (error) => {
      console.error("Hostname validation failed:", error);
    },
  });

  const validateHostnameAsync = useCallback(
    (hostname: string, excludeConfigId?: string) => {
      return mutation.mutateAsync({ hostname, excludeConfigId });
    },
    [mutation]
  );

  const validateHostnameSync = useCallback(
    (hostname: string, excludeConfigId?: string) => {
      mutation.mutate({ hostname, excludeConfigId });
    },
    [mutation]
  );

  const reset = useCallback(() => {
    mutation.reset();
    setLastValidatedHostname(null);
  }, [mutation]);

  return {
    // Validation state
    isValidating: mutation.isPending,
    validationResult: mutation.data,
    validationError: mutation.error,

    // Status helpers
    isValid: mutation.data?.isValid ?? false,
    isAvailable: mutation.data?.isAvailable ?? false,
    hasConflicts: mutation.data && !mutation.data.isAvailable,

    // Conflict details
    conflictDetails: mutation.data?.conflictDetails,
    suggestions: mutation.data?.suggestions ?? [],

    // Actions
    validateHostname: validateHostnameSync,
    validateHostnameAsync,
    reset,

    // Metadata
    lastValidatedHostname,
    validationMessage: mutation.data?.message,
  };
}

/**
 * Hook for real-time hostname validation with debouncing
 * Automatically validates hostname after a delay when it changes
 */
export function useHostnameValidationWithDebounce(
  hostname: string,
  excludeConfigId?: string,
  debounceMs = 500,
  enabled = true
) {
  const [debouncedHostname, setDebouncedHostname] = useState(hostname);
  const validation = useHostnameValidation();

  // Debounce hostname changes
  React.useEffect(() => {
    if (!enabled || !hostname) {
      return;
    }

    const timer = setTimeout(() => {
      setDebouncedHostname(hostname);
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [hostname, debounceMs, enabled]);

  // Validate debounced hostname
  React.useEffect(() => {
    if (!enabled || !debouncedHostname || debouncedHostname === validation.lastValidatedHostname) {
      return;
    }

    // Basic format validation before API call
    const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    if (!hostnameRegex.test(debouncedHostname) || debouncedHostname.length > 253) {
      return; // Skip API call for obviously invalid hostnames
    }

    validation.validateHostname(debouncedHostname, excludeConfigId);
  }, [debouncedHostname, excludeConfigId, enabled, validation, validation.lastValidatedHostname]);

  return {
    ...validation,
    debouncedHostname,
    isDebouncing: hostname !== debouncedHostname,
  };
}

/**
 * Hook for getting hostname suggestions based on conflicts
 * Provides helpful hostname alternatives when conflicts are detected
 */
export function useHostnameSuggestions(baseHostname: string, validationResult?: HostnameValidationResult) {
  const generateSuggestions = useCallback((hostname: string) => {
    if (!hostname) return [];

    const parts = hostname.split('.');
    const subdomain = parts[0];
    const domain = parts.slice(1).join('.');

    const suggestions: string[] = [];

    // Add prefixes
    suggestions.push(`api-${subdomain}.${domain}`);
    suggestions.push(`new-${subdomain}.${domain}`);
    suggestions.push(`v2-${subdomain}.${domain}`);

    // Add subdomain variations
    if (domain) {
      suggestions.push(`api.${hostname}`);
      suggestions.push(`app.${hostname}`);
      suggestions.push(`web.${hostname}`);
    }

    // Add suffix variations
    suggestions.push(`${subdomain}-api.${domain}`);
    suggestions.push(`${subdomain}-app.${domain}`);
    suggestions.push(`${subdomain}-new.${domain}`);

    // Remove duplicates and the original hostname
    return [...new Set(suggestions)].filter(s => s !== hostname && s.length <= 253);
  }, []);

  const suggestions = React.useMemo(() => {
    if (validationResult?.suggestions && validationResult.suggestions.length > 0) {
      return validationResult.suggestions;
    }

    if (validationResult?.conflictDetails) {
      return generateSuggestions(baseHostname);
    }

    return [];
  }, [baseHostname, validationResult, generateSuggestions]);

  return {
    suggestions,
    hasSuggestions: suggestions.length > 0,
    generateSuggestions: (hostname: string) => generateSuggestions(hostname),
  };
}