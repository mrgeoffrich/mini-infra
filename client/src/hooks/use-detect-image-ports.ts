import { useMutation } from "@tanstack/react-query";

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
  const url = new URL("/api/images/inspect-ports", window.location.origin);
  url.searchParams.set("image", image);
  url.searchParams.set("tag", tag);

  const res = await fetch(url.toString(), {
    credentials: "include",
  });

  let data: DetectPortsResponse;
  try {
    data = await res.json();
  } catch {
    return {
      status: "error",
      message: `Unexpected response (${res.status})`,
    };
  }

  if (res.ok && data.success) {
    return { status: "success", ports: data.ports };
  }

  const message = data.error ?? `Failed to inspect image (${res.status})`;

  if (res.status === 404) {
    return { status: "not-found", message };
  }
  if (res.status === 502 && /authentication/i.test(message)) {
    return { status: "auth-required", message };
  }
  return { status: "error", message };
}

export function useDetectImagePorts() {
  return useMutation({
    mutationFn: validateImage,
  });
}
