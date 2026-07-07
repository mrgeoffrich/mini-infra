import { useMutation } from "@tanstack/react-query";
import { ApiRoute } from "@mini-infra/types";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

interface DetectPortsParams {
  image: string;
  tag: string;
}

interface DetectPortsResponse {
  success: boolean;
  ports: number[];
  error?: string;
}

export type ImageValidationResult =
  | { status: "success"; ports: number[] }
  | { status: "not-found"; message: string }
  | { status: "auth-required"; message: string }
  | { status: "error"; message: string };

async function validateImage({
  image,
  tag,
}: DetectPortsParams): Promise<ImageValidationResult> {
  const url = new URL(ApiRoute.images.inspectPorts(), window.location.origin);
  url.searchParams.set("image", image);
  url.searchParams.set("tag", tag);

  try {
    // Raw response — `{success, ports, error}` has no `{success, data}`
    // envelope, and its `error` field is a human-readable message (not a
    // machine code), so it's read straight off `.body` rather than via
    // apiFetch's `.message`/`.code` extraction (which look for `.message`
    // and `.error`-as-code respectively — a mismatch for this shape).
    const data = await apiFetch<DetectPortsResponse>(url.toString(), {
      unwrap: false,
      correlationIdPrefix: "images",
    });

    if (!data) {
      return { status: "error", message: `Unexpected response` };
    }
    if (data.success) {
      return { status: "success", ports: data.ports };
    }
    return { status: "error", message: data.error ?? "Failed to inspect image" };
  } catch (err) {
    if (err instanceof ApiRequestError) {
      // The route now throws taxonomy errors (Phase 7 of
      // docs/planning/not-shipped/error-handling-overhaul-plan.md), so the
      // envelope's `message` is the human string (and `err.code`, which
      // reads `body.error`, is now a stable machine code rather than human
      // text) — `apiFetch`'s `extractMessage` already resolves `err.message`
      // to `body.message`, falling back to the HTTP status text.
      const message = err.message || `Failed to inspect image (${err.status})`;
      if (err.status === 404) {
        return { status: "not-found", message };
      }
      if (err.status === 401 || err.status === 403) {
        return { status: "auth-required", message };
      }
      return { status: "error", message };
    }
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Unexpected error",
    };
  }
}

export function useDetectImagePorts() {
  return useMutation({
    mutationFn: validateImage,
  });
}
