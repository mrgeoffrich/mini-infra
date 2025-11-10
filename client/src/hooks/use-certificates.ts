import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  TlsCertificate,
  TlsCertificateRenewal,
  CreateCertificateRequest,
} from "@mini-infra/types";

async function fetchCertificates(): Promise<TlsCertificate[]> {
  const response = await fetch("/api/tls/certificates", {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch certificates: ${response.statusText}`);
  }

  const data = await response.json();
  return data.data || [];
}

async function fetchCertificate(id: string): Promise<TlsCertificate> {
  const response = await fetch(`/api/tls/certificates/${id}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch certificate: ${response.statusText}`);
  }

  const data = await response.json();
  return data.data;
}

async function createCertificate(
  request: CreateCertificateRequest
): Promise<TlsCertificate> {
  const response = await fetch("/api/tls/certificates", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || "Failed to create certificate");
  }

  const data = await response.json();
  return data.data;
}

async function renewCertificate(id: string): Promise<TlsCertificate> {
  const response = await fetch(`/api/tls/certificates/${id}/renew`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || "Failed to renew certificate");
  }

  const data = await response.json();
  return data.data;
}

async function revokeCertificate(id: string): Promise<void> {
  const response = await fetch(`/api/tls/certificates/${id}`, {
    method: "DELETE",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || "Failed to revoke certificate");
  }
}

async function fetchRenewalHistory(
  certificateId: string
): Promise<TlsCertificateRenewal[]> {
  const response = await fetch(
    `/api/tls/renewals?certificateId=${certificateId}`,
    {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch renewal history: ${response.statusText}`);
  }

  const data = await response.json();
  return data.data || [];
}

export function useCertificates() {
  return useQuery({
    queryKey: ["certificates"],
    queryFn: fetchCertificates,
    staleTime: 30000, // 30 seconds
  });
}

export function useCertificate(id: string) {
  return useQuery({
    queryKey: ["certificates", id],
    queryFn: () => fetchCertificate(id),
    enabled: !!id,
  });
}

export function useCreateCertificate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createCertificate,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["certificates"] });
      toast.success(`Certificate issued for ${data.primaryDomain}`);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to issue certificate");
    },
  });
}

export function useRenewCertificate(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => renewCertificate(id),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["certificates"] });
      queryClient.invalidateQueries({ queryKey: ["certificates", id] });
      queryClient.invalidateQueries({ queryKey: ["renewals", id] });
      toast.success(`Certificate renewal initiated for ${data.primaryDomain}`);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to renew certificate");
    },
  });
}

export function useRevokeCertificate(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => revokeCertificate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["certificates"] });
      toast.success("Certificate revoked successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to revoke certificate");
    },
  });
}

export function useRenewalHistory(certificateId: string) {
  return useQuery({
    queryKey: ["renewals", certificateId],
    queryFn: () => fetchRenewalHistory(certificateId),
    enabled: !!certificateId,
  });
}
