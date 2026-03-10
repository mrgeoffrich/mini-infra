/**
 * Manual Frontend Setup Service
 *
 * Orchestrates the multi-step process of connecting a container to HAProxy,
 * emitting step-by-step progress via a callback. Used by the fire-and-forget
 * POST handler to provide real-time Socket.IO feedback.
 */

import { PrismaClient } from "@prisma/client";
import { loadbalancerLogger } from "../../lib/logger-factory";
import { ManualFrontendManager } from "./manual-frontend-manager";
import { HAProxyDataPlaneClient } from "./haproxy-dataplane-client";
import { CertificateProvisioningService } from "../tls/certificate-provisioning-service";
import { CertificateLifecycleManager } from "../tls/certificate-lifecycle-manager";
import { CertificateDistributor } from "../tls/certificate-distributor";
import type { CreateManualFrontendRequest, ManualFrontendSetupStep, ManualFrontendSetupResult } from "@mini-infra/types";

const logger = loadbalancerLogger();

export type SetupStepCallback = (
  step: ManualFrontendSetupStep,
  completedCount: number,
  totalSteps: number,
) => void;

export class ManualFrontendSetupService {
  constructor(
    private readonly manualFrontendManager: ManualFrontendManager,
    private readonly provisioningService: CertificateProvisioningService,
    private readonly lifecycleManager: CertificateLifecycleManager,
    private readonly distributor: CertificateDistributor,
    private readonly prisma: PrismaClient,
  ) {}

  async setup(
    request: CreateManualFrontendRequest,
    haproxyClient: HAProxyDataPlaneClient,
    userId: string,
    onStep?: SetupStepCallback,
  ): Promise<ManualFrontendSetupResult> {
    const totalSteps = request.enableSsl ? 4 : 2;
    const steps: ManualFrontendSetupStep[] = [];
    const errors: string[] = [];
    let stepCount = 0;
    let resolvedCertId: string | undefined;

    const emitStep = (step: string, status: ManualFrontendSetupStep['status'], detail?: string) => {
      stepCount++;
      const s: ManualFrontendSetupStep = { step, status, detail };
      steps.push(s);
      if (status === 'failed' && detail) errors.push(detail);
      try { onStep?.(s, stepCount, totalSteps); } catch { /* never break setup */ }
    };

    try {
      // Step 1: Validate container connectivity
      logger.info({ containerId: request.containerId, environmentId: request.environmentId }, "Step 1: Validating container");
      const validation = await this.manualFrontendManager.validateContainer(
        request.containerId,
        request.environmentId,
        this.prisma,
      );
      if (!validation.isValid) {
        const detail = `Container validation failed: ${validation.errors.join(", ")}`;
        emitStep("Validate container connectivity", "failed", detail);
        return { success: false, steps, errors };
      }
      emitStep("Validate container connectivity", "completed");

      // Step 2: Create backend and server (delegates to existing manager logic)
      logger.info({ containerId: request.containerId }, "Step 2: Creating backend and server");
      try {
        // We use createManualFrontend which does backend+frontend+route in one call.
        // But we need to split for progress. Since the manager is a monolith,
        // we pass a modified request that always has tlsCertificateId resolved.
        // The manager will handle backend, frontend, and route creation atomically.

        // First, handle TLS steps 3-4 before we call createManualFrontend
        if (request.enableSsl) {
          // Step 3: Find or issue TLS certificate
          logger.info({ hostname: request.hostname }, "Step 3: Finding or issuing TLS certificate");
          try {
            const existingCert = await this.provisioningService.findCertificateForHostname(request.hostname);

            if (existingCert) {
              resolvedCertId = existingCert.id;
              emitStep("Find or issue TLS certificate", "completed", `Existing certificate found for ${request.hostname}`);
            } else {
              // Issue new certificate
              logger.info({ hostname: request.hostname }, "No existing cert found, issuing new certificate");
              const newCert = await this.lifecycleManager.issueCertificate({
                domains: [request.hostname],
                primaryDomain: request.hostname,
                userId,
                deployToHaproxy: false, // We handle deployment in step 4
              });
              resolvedCertId = newCert.id;
              emitStep("Find or issue TLS certificate", "completed", `New certificate issued for ${request.hostname}`);
            }
          } catch (certError) {
            const detail = certError instanceof Error ? certError.message : "Certificate provisioning failed";
            emitStep("Find or issue TLS certificate", "failed", detail);
            // Continue without SSL — soft failure
            logger.warn({ hostname: request.hostname, error: detail }, "TLS certificate provisioning failed, continuing without SSL");
          }

          // Step 4: Deploy certificate to HAProxy
          if (resolvedCertId) {
            logger.info({ certificateId: resolvedCertId }, "Step 4: Deploying certificate to HAProxy");
            try {
              const cert = await this.prisma.tlsCertificate.findUnique({ where: { id: resolvedCertId } });
              if (cert?.blobName) {
                const deployResult = await this.distributor.deployCertificate(cert.blobName);
                if (deployResult.success) {
                  emitStep("Deploy certificate to HAProxy", "completed", `Method: ${deployResult.method}`);
                } else {
                  emitStep("Deploy certificate to HAProxy", "failed", deployResult.error || "Deployment failed");
                }
              } else {
                emitStep("Deploy certificate to HAProxy", "skipped", "Certificate blob not available");
              }
            } catch (deployError) {
              const detail = deployError instanceof Error ? deployError.message : "Certificate deployment failed";
              emitStep("Deploy certificate to HAProxy", "failed", detail);
            }
          } else {
            emitStep("Deploy certificate to HAProxy", "skipped", "No certificate available");
          }
        }

        // Now create the manual frontend (backend + shared frontend + route + DB records)
        // Build the request with the resolved cert ID
        const requestWithCert: any = {
          ...request,
          tlsCertificateId: resolvedCertId,
          // If cert failed, disable SSL
          enableSsl: resolvedCertId ? request.enableSsl : false,
        };

        const frontend = await this.manualFrontendManager.createManualFrontend(
          requestWithCert,
          haproxyClient,
          this.prisma,
        );

        emitStep("Create backend, frontend and route", "completed", `Frontend: ${frontend.frontendName}`);

        return {
          success: true,
          steps,
          errors,
          frontendId: frontend.id,
          certificateId: resolvedCertId,
        };
      } catch (createError) {
        const detail = createError instanceof Error ? createError.message : "Frontend creation failed";
        emitStep("Create backend, frontend and route", "failed", detail);
        return { success: false, steps, errors };
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Setup failed unexpectedly";
      errors.push(detail);
      logger.error({ error: detail, request }, "Manual frontend setup failed");
      return { success: false, steps, errors };
    }
  }
}
