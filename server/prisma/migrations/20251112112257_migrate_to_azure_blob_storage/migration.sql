/*
  Warnings:

  - You are about to drop the column `keyVaultSecretName` on the `acme_accounts` table. All the data in the column will be lost.
  - You are about to drop the column `keyVaultVersion` on the `tls_certificate_renewals` table. All the data in the column will be lost.
  - You are about to drop the column `keyVaultCertificateName` on the `tls_certificates` table. All the data in the column will be lost.
  - You are about to drop the column `keyVaultSecretId` on the `tls_certificates` table. All the data in the column will be lost.
  - You are about to drop the column `keyVaultVersion` on the `tls_certificates` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_acme_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountUrl" TEXT NOT NULL,
    "blobContainerName" TEXT,
    "blobName" TEXT,
    "keyAlgorithm" TEXT NOT NULL DEFAULT 'RSA-2048',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "termsOfServiceUrl" TEXT,
    "agreedToTermsAt" DATETIME,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_acme_accounts" ("accountUrl", "agreedToTermsAt", "createdAt", "createdBy", "email", "id", "keyAlgorithm", "provider", "status", "termsOfServiceUrl", "updatedAt") SELECT "accountUrl", "agreedToTermsAt", "createdAt", "createdBy", "email", "id", "keyAlgorithm", "provider", "status", "termsOfServiceUrl", "updatedAt" FROM "acme_accounts";
DROP TABLE "acme_accounts";
ALTER TABLE "new_acme_accounts" RENAME TO "acme_accounts";
CREATE UNIQUE INDEX "acme_accounts_email_key" ON "acme_accounts"("email");
CREATE UNIQUE INDEX "acme_accounts_accountUrl_key" ON "acme_accounts"("accountUrl");
CREATE UNIQUE INDEX "acme_accounts_blobName_key" ON "acme_accounts"("blobName");
CREATE INDEX "acme_accounts_email_idx" ON "acme_accounts"("email");
CREATE INDEX "acme_accounts_provider_idx" ON "acme_accounts"("provider");
CREATE TABLE "new_tls_certificate_renewals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "certificateId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "durationMs" INTEGER,
    "acmeOrderUrl" TEXT,
    "acmeChallengeType" TEXT,
    "dnsRecordName" TEXT,
    "dnsRecordValue" TEXT,
    "blobETag" TEXT,
    "haproxyReloadMethod" TEXT,
    "haproxyReloadSuccess" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "errorCode" TEXT,
    "errorDetails" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "metadata" TEXT,
    CONSTRAINT "tls_certificate_renewals_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "tls_certificates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_tls_certificate_renewals" ("acmeChallengeType", "acmeOrderUrl", "attemptNumber", "certificateId", "completedAt", "dnsRecordName", "dnsRecordValue", "durationMs", "errorCode", "errorDetails", "errorMessage", "haproxyReloadMethod", "haproxyReloadSuccess", "id", "metadata", "startedAt", "status", "triggeredBy") SELECT "acmeChallengeType", "acmeOrderUrl", "attemptNumber", "certificateId", "completedAt", "dnsRecordName", "dnsRecordValue", "durationMs", "errorCode", "errorDetails", "errorMessage", "haproxyReloadMethod", "haproxyReloadSuccess", "id", "metadata", "startedAt", "status", "triggeredBy" FROM "tls_certificate_renewals";
DROP TABLE "tls_certificate_renewals";
ALTER TABLE "new_tls_certificate_renewals" RENAME TO "tls_certificate_renewals";
CREATE INDEX "tls_certificate_renewals_certificateId_idx" ON "tls_certificate_renewals"("certificateId");
CREATE INDEX "tls_certificate_renewals_status_idx" ON "tls_certificate_renewals"("status");
CREATE INDEX "tls_certificate_renewals_startedAt_idx" ON "tls_certificate_renewals"("startedAt");
CREATE TABLE "new_tls_certificates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "domains" TEXT NOT NULL,
    "primaryDomain" TEXT NOT NULL,
    "certificateType" TEXT NOT NULL DEFAULT 'ACME',
    "acmeProvider" TEXT,
    "acmeAccountId" TEXT,
    "acmeOrderUrl" TEXT,
    "blobContainerName" TEXT,
    "blobName" TEXT,
    "issuer" TEXT,
    "serialNumber" TEXT,
    "fingerprint" TEXT,
    "issuedAt" DATETIME NOT NULL,
    "notBefore" DATETIME NOT NULL,
    "notAfter" DATETIME NOT NULL,
    "renewAfter" DATETIME NOT NULL,
    "lastRenewedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "lastErrorAt" DATETIME,
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "renewalDaysBeforeExpiry" INTEGER NOT NULL DEFAULT 30,
    "haproxyFrontendNames" TEXT,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_tls_certificates" ("acmeAccountId", "acmeOrderUrl", "acmeProvider", "autoRenew", "certificateType", "createdAt", "createdBy", "domains", "fingerprint", "haproxyFrontendNames", "id", "issuedAt", "issuer", "lastError", "lastErrorAt", "lastRenewedAt", "notAfter", "notBefore", "primaryDomain", "renewAfter", "renewalDaysBeforeExpiry", "serialNumber", "status", "updatedAt", "updatedBy") SELECT "acmeAccountId", "acmeOrderUrl", "acmeProvider", "autoRenew", "certificateType", "createdAt", "createdBy", "domains", "fingerprint", "haproxyFrontendNames", "id", "issuedAt", "issuer", "lastError", "lastErrorAt", "lastRenewedAt", "notAfter", "notBefore", "primaryDomain", "renewAfter", "renewalDaysBeforeExpiry", "serialNumber", "status", "updatedAt", "updatedBy" FROM "tls_certificates";
DROP TABLE "tls_certificates";
ALTER TABLE "new_tls_certificates" RENAME TO "tls_certificates";
CREATE UNIQUE INDEX "tls_certificates_blobName_key" ON "tls_certificates"("blobName");
CREATE UNIQUE INDEX "tls_certificates_fingerprint_key" ON "tls_certificates"("fingerprint");
CREATE INDEX "tls_certificates_primaryDomain_idx" ON "tls_certificates"("primaryDomain");
CREATE INDEX "tls_certificates_status_idx" ON "tls_certificates"("status");
CREATE INDEX "tls_certificates_renewAfter_idx" ON "tls_certificates"("renewAfter");
CREATE INDEX "tls_certificates_notAfter_idx" ON "tls_certificates"("notAfter");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
