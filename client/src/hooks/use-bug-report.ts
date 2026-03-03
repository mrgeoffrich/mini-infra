import { useMutation } from "@tanstack/react-query";
import type {
  BugReportRequest,
  BugReportResponse,
} from "@mini-infra/types";

// Hook for submitting a bug report
export function useSubmitBugReport() {
  return useMutation<BugReportResponse, Error, BugReportRequest>({
    mutationFn: async (bugReport) => {
      const response = await fetch("/api/github/bug-report", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(bugReport),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          message: "Failed to submit bug report",
        }));
        throw new Error(errorData.message || "Failed to submit bug report");
      }

      return response.json();
    },
  });
}
