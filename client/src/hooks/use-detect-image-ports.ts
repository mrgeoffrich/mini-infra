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

async function detectImagePorts({ image, tag }: DetectPortsParams): Promise<number[]> {
  const url = new URL("/api/images/inspect-ports", window.location.origin);
  url.searchParams.set("image", image);
  url.searchParams.set("tag", tag);

  const res = await fetch(url.toString(), {
    credentials: "include",
  });

  const data: DetectPortsResponse = await res.json();

  if (!res.ok || !data.success) {
    throw new Error(data.error ?? "Failed to detect ports");
  }

  return data.ports;
}

export function useDetectImagePorts() {
  return useMutation({
    mutationFn: detectImagePorts,
  });
}
