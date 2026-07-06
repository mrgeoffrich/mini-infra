import { useMutation } from "@tanstack/react-query";
import { ApiRoute } from "@mini-infra/types";
import type { BugReportRequest, BugReportResponse } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

// The server returns the full `{ success, data, message }` envelope as the
// `BugReportResponse` shape itself (not just the inner `data`), and
// bug-report-dialog.tsx reads `response.data.issueUrl` off the resolved
// mutation value — so this is RAW from apiFetch's point of view: unwrap:false
// so callers keep getting the whole body, matching the pre-migration shape.
export function useSubmitBugReport() {
  return useMutation<BugReportResponse, Error, BugReportRequest>({
    mutationFn: (bugReport) =>
      apiFetch<BugReportResponse>(ApiRoute.githubBugReport.create(), {
        method: "POST",
        body: bugReport,
        unwrap: false,
        correlationIdPrefix: "bug-report",
      }),
  });
}
