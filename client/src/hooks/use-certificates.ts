import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import type {
  TlsCertificate,
  TlsCertificateRenewal,
  CreateCertificateRequest,
} from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

async function fetchCertificates(): Promise<TlsCertificate[]> {
  return (
    (await apiFetch<TlsCertificate[]>(ApiRoute.tls.certificates(), {
      correlationIdPrefix: "certificates",
    })) ?? []
  );
}

async function fetchCertificate(id: string): Promise<TlsCertificate> {
  return apiFetch<TlsCertificate>(ApiRoute.tls.certificate(id), {
    correlationIdPrefix: "certificates",
  });
}

async function createCertificate(
  request: CreateCertificateRequest
): Promise<TlsCertificate> {
  return apiFetch<TlsCertificate>(ApiRoute.tls.certificates(), {
    method: "POST",
    body: request,
    correlationIdPrefix: "certificates",
  });
}

async function renewCertificate(id: string): Promise<TlsCertificate> {
  return apiFetch<TlsCertificate>(ApiRoute.tls.certificateRenew(id), {
    method: "POST",
    correlationIdPrefix: "certificates",
  });
}

async function revokeCertificate(id: string): Promise<void> {
  await apiFetch<void>(ApiRoute.tls.certificate(id), {
    method: "DELETE",
    correlationIdPrefix: "certificates",
  });
}

async function fetchRenewalHistory(
  certificateId: string
): Promise<TlsCertificateRenewal[]> {
  const url = new URL(ApiRoute.tls.renewals(), window.location.origin);
  url.searchParams.set("certificateId", certificateId);

  return (
    (await apiFetch<TlsCertificateRenewal[]>(url.toString(), {
      correlationIdPrefix: "renewals",
    })) ?? []
  );
}

export function useCertificates() {
  return useQuery({
    queryKey: queryKeys.tls.certificates,
    queryFn: fetchCertificates,
    staleTime: 30000, // 30 seconds
  });
}

export function useCertificate(id: string) {
  return useQuery({
    queryKey: queryKeys.tls.certificate(id),
    queryFn: () => fetchCertificate(id),
    enabled: !!id,
  });
}

export function useCreateCertificate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createCertificate,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tls.certificates });
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
      queryClient.invalidateQueries({ queryKey: queryKeys.tls.certificates });
      queryClient.invalidateQueries({ queryKey: queryKeys.tls.certificate(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tls.renewals(id) });
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
      queryClient.invalidateQueries({ queryKey: queryKeys.tls.certificates });
      toast.success("Certificate revoked successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to revoke certificate");
    },
  });
}

export function useRenewalHistory(certificateId: string) {
  return useQuery({
    queryKey: queryKeys.tls.renewals(certificateId),
    queryFn: () => fetchRenewalHistory(certificateId),
    enabled: !!certificateId,
  });
}
