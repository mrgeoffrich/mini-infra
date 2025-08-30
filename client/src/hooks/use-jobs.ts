import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback, useRef, useEffect } from "react";
import {
  CreateJobRequest,
  JobResponse,
  JobListResponse,
  StartJobResponse,
  JobExecutionResponse,
  JobStreamParams,
  QueryParams,
  ApiResponse,
} from "@mini-infra/types";
import {
  JobStatus,
  JobProgress,
  Job,
  JobExecution,
  JobLog,
} from "@mini-infra/types";
import {
  JobStartedEvent,
  JobProgressEvent,
  JobLogEvent,
  JobStatusEvent,
  JobCompletedEvent,
  JobErrorEvent,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `jobs-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Job API Functions
// ====================

async function fetchJobs(
  params: QueryParams = {},
  correlationId: string,
): Promise<JobListResponse> {
  const url = new URL(`/api/jobs`, window.location.origin);

  // Add query parameters
  if (params.page) url.searchParams.set("page", params.page.toString());
  if (params.limit) url.searchParams.set("limit", params.limit.toString());
  if (params.search) url.searchParams.set("search", params.search);
  if (params.sortBy) url.searchParams.set("sortBy", params.sortBy);
  if (params.sortOrder) url.searchParams.set("sortOrder", params.sortOrder);

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch jobs: ${response.statusText}`);
  }

  const data: JobListResponse = await response.json();
  
  return data;
}

async function fetchJobDetails(
  jobId: string,
  correlationId: string,
): Promise<JobResponse> {
  const response = await fetch(`/api/jobs/${jobId}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch job details: ${response.statusText}`);
  }

  const data: ApiResponse<JobResponse> = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch job details");
  }

  return data.data!;
}

async function createJob(
  jobData: CreateJobRequest,
  correlationId: string,
): Promise<StartJobResponse> {
  const response = await fetch(`/api/jobs`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(jobData),
  });

  if (!response.ok) {
    throw new Error(`Failed to create job: ${response.statusText}`);
  }

  const data: ApiResponse<StartJobResponse> = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to create job");
  }

  return data.data!;
}

// ====================
// Job Query Hooks
// ====================

export interface UseJobsOptions {
  enabled?: boolean;
  page?: number;
  limit?: number;
  search?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  refetchInterval?: number;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
}

export function useJobs(options: UseJobsOptions = {}) {
  const {
    enabled = true,
    page = 1,
    limit = 10,
    search,
    sortBy = "createdAt",
    sortOrder = "desc",
    refetchInterval = 5000, // Poll every 5 seconds for job updates
    retry = 3,
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["jobs", { page, limit, search, sortBy, sortOrder }],
    queryFn: () =>
      fetchJobs({ page, limit, search, sortBy, sortOrder }, correlationId),
    enabled,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            // Don't retry on authentication errors
            if (
              error.message.includes("401") ||
              error.message.includes("Unauthorized")
            ) {
              return false;
            }
            // Retry up to the specified number of times for other errors
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000), // Exponential backoff with max 30s
    staleTime: 2000, // Data is fresh for 2 seconds
    gcTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export interface UseJobDetailsOptions {
  enabled?: boolean;
  retry?: number | boolean | ((failureCount: number, error: Error) => boolean);
  refetchInterval?: number;
}

export function useJobDetails(
  jobId: string,
  options: UseJobDetailsOptions = {},
) {
  const { 
    enabled = true, 
    retry = 3,
    refetchInterval = 5000 // Poll for job status updates
  } = options;
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["job", jobId],
    queryFn: () => fetchJobDetails(jobId, correlationId),
    enabled: enabled && !!jobId,
    refetchInterval,
    retry:
      typeof retry === "function"
        ? retry
        : (failureCount: number, error: Error) => {
            // Don't retry on authentication errors
            if (
              error.message.includes("401") ||
              error.message.includes("Unauthorized")
            ) {
              return false;
            }
            // Retry up to the specified number of times for other errors
            return typeof retry === "boolean" ? retry : failureCount < retry;
          },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    staleTime: 2000,
    gcTime: 5 * 60 * 1000,
  });
}

// ====================
// Job Mutation Hooks
// ====================

export function useCreateJob() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (jobData: CreateJobRequest) =>
      createJob(jobData, correlationId),
    onSuccess: () => {
      // Invalidate and refetch jobs list
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
}

// ====================
// Job Status Hook with SSE
// ====================

export interface JobStatusUpdate {
  status: JobStatus;
  progress?: JobProgress;
  logs: JobLog[];
  error?: string;
  isComplete: boolean;
  isConnected: boolean;
}

export function useJobStatus(sessionId: string, jobId?: string) {
  const [statusUpdate, setStatusUpdate] = useState<JobStatusUpdate>({
    status: JobStatus.PENDING,
    logs: [],
    isComplete: false,
    isConnected: false,
  });
  
  const eventSourceRef = useRef<EventSource | null>(null);
  const logsRef = useRef<JobLog[]>([]);

  useEffect(() => {
    if (!sessionId) return;

    const connectToSSE = () => {
      // Clean up existing connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      // Build SSE URL
      const url = new URL(`/api/jobs/stream`, window.location.origin);
      url.searchParams.set("sessionId", sessionId);
      if (jobId) {
        url.searchParams.set("jobId", jobId);
      }

      const eventSource = new EventSource(url.toString(), {
        withCredentials: true,
      });

      eventSourceRef.current = eventSource;

      // Connection opened
      eventSource.onopen = () => {
        setStatusUpdate(prev => ({
          ...prev,
          isConnected: true,
        }));
      };

      // Handle different event types
      eventSource.addEventListener("job-started", (event) => {
        const data: JobStartedEvent = JSON.parse(event.data);
        setStatusUpdate(prev => ({
          ...prev,
          status: JobStatus.IN_PROGRESS,
          isComplete: false,
        }));
        
        // Add start log
        const startLog: JobLog = {
          id: `start-${Date.now()}`,
          jobId: data.jobId,
          timestamp: new Date(data.timestamp),
          level: "info",
          message: data.message,
          source: "system",
        };
        logsRef.current = [...logsRef.current, startLog];
        setStatusUpdate(prev => ({
          ...prev,
          logs: [...logsRef.current],
        }));
      });

      eventSource.addEventListener("job-progress", (event) => {
        const data: JobProgressEvent = JSON.parse(event.data);
        setStatusUpdate(prev => ({
          ...prev,
          progress: data.progress,
        }));
      });

      eventSource.addEventListener("job-log", (event) => {
        const data: JobLogEvent = JSON.parse(event.data);
        const newLog: JobLog = {
          id: `log-${Date.now()}-${Math.random()}`,
          jobId: data.jobId,
          timestamp: new Date(data.timestamp),
          level: data.level,
          message: data.message,
          source: data.source,
        };
        logsRef.current = [...logsRef.current, newLog];
        setStatusUpdate(prev => ({
          ...prev,
          logs: [...logsRef.current],
        }));
      });

      eventSource.addEventListener("job-status", (event) => {
        const data: JobStatusEvent = JSON.parse(event.data);
        setStatusUpdate(prev => ({
          ...prev,
          status: data.status,
        }));
      });

      eventSource.addEventListener("job-completed", (event) => {
        const data: JobCompletedEvent = JSON.parse(event.data);
        setStatusUpdate(prev => ({
          ...prev,
          status: data.status,
          isComplete: true,
        }));
        
        // Add completion log
        const completionLog: JobLog = {
          id: `complete-${Date.now()}`,
          jobId: data.jobId,
          timestamp: new Date(data.timestamp),
          level: "info",
          message: data.message,
          source: "system",
        };
        logsRef.current = [...logsRef.current, completionLog];
        setStatusUpdate(prev => ({
          ...prev,
          logs: [...logsRef.current],
        }));
      });

      eventSource.addEventListener("job-error", (event) => {
        const data: JobErrorEvent = JSON.parse(event.data);
        setStatusUpdate(prev => ({
          ...prev,
          status: JobStatus.FAILED,
          error: data.error,
          isComplete: true,
        }));
        
        // Add error log
        const errorLog: JobLog = {
          id: `error-${Date.now()}`,
          jobId: data.jobId,
          timestamp: new Date(data.timestamp),
          level: "error",
          message: data.error,
          source: "system",
        };
        logsRef.current = [...logsRef.current, errorLog];
        setStatusUpdate(prev => ({
          ...prev,
          logs: [...logsRef.current],
        }));
      });

      // Connection errors
      eventSource.onerror = () => {
        setStatusUpdate(prev => ({
          ...prev,
          isConnected: false,
        }));
        
        // Attempt to reconnect after 3 seconds
        setTimeout(() => {
          if (eventSourceRef.current?.readyState === EventSource.CLOSED) {
            connectToSSE();
          }
        }, 3000);
      };
    };

    connectToSSE();

    // Cleanup function
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [sessionId, jobId]);

  // Function to reset logs (useful for starting a new job)
  const resetLogs = useCallback(() => {
    logsRef.current = [];
    setStatusUpdate(prev => ({
      ...prev,
      logs: [],
      status: JobStatus.PENDING,
      progress: undefined,
      error: undefined,
      isComplete: false,
    }));
  }, []);

  // Function to disconnect SSE
  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      setStatusUpdate(prev => ({
        ...prev,
        isConnected: false,
      }));
    }
  }, []);

  return {
    ...statusUpdate,
    resetLogs,
    disconnect,
  };
}

// ====================
// Job Filters Hook
// ====================

export interface JobFiltersState {
  search?: string;
  status?: JobStatus;
  sortBy: string;
  sortOrder: "asc" | "desc";
  page: number;
  limit: number;
}

export function useJobFilters(
  initialFilters: Partial<JobFiltersState> = {},
) {
  const [filters, setFilters] = useState<JobFiltersState>({
    sortBy: "createdAt",
    sortOrder: "desc",
    page: 1,
    limit: 10,
    ...initialFilters,
  });

  const updateFilter = useCallback(
    <K extends keyof JobFiltersState>(
      key: K,
      value: JobFiltersState[K],
    ) => {
      setFilters((prev) => ({
        ...prev,
        [key]: value,
        // Reset to first page when filters change (except when updating page itself)
        page: key === "page" ? (value as number) : 1,
      }));
    },
    [],
  );

  const resetFilters = useCallback(() => {
    setFilters({
      sortBy: "createdAt",
      sortOrder: "desc",
      page: 1,
      limit: 10,
      ...initialFilters,
    });
  }, [initialFilters]);

  return {
    filters,
    updateFilter,
    resetFilters,
  };
}

// ====================
// Type Exports
// ====================

export type {
  CreateJobRequest,
  JobResponse,
  JobListResponse,
  StartJobResponse,
  JobExecutionResponse,
  JobStreamParams,
  JobStatus,
  JobProgress,
  Job,
  JobExecution,
  JobLog,
};