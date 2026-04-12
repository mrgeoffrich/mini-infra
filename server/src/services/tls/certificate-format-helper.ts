/**
 * Certificate Format Helper
 *
 * This utility provides functions for parsing and formatting X.509 certificates using node-forge.
 * It handles certificate metadata extraction and PEM formatting.
 */

import forge from "node-forge";
import { CertificateParseResult } from "./types";

/**
 * Parse X.509 certificate from PEM format
 *
 * @param certificatePem - PEM-encoded certificate
 * @returns Parsed certificate information
 */
export async function parseCertificate(certificatePem: string): Promise<CertificateParseResult> {
  try {
    // Parse PEM certificate
    const cert = forge.pki.certificateFromPem(certificatePem);

    // Extract common name from subject
    const subjectCN = cert.subject.getField("CN");
    const subject = subjectCN ? subjectCN.value : "Unknown";

    // Extract common name from issuer
    const issuerCN = cert.issuer.getField("CN");
    const issuer = issuerCN ? issuerCN.value : "Unknown";

    // Calculate SHA-256 fingerprint
    const derCert = forge.asn1.toDer(forge.pki.certificateToAsn1(cert));
    const md = forge.md.sha256.create();
    md.update(derCert.getBytes());
    const fingerprint = md.digest().toHex();

    return {
      issuer,
      subject,
      serialNumber: cert.serialNumber,
      notBefore: cert.validity.notBefore,
      notAfter: cert.validity.notAfter,
      fingerprint,
    };
  } catch (error) {
    throw new Error(`Failed to parse certificate: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * Combine certificate and private key into a single PEM file (HAProxy format)
 *
 * @param certificatePem - PEM-encoded certificate
 * @param privateKeyPem - PEM-encoded private key
 * @param chainPem - Optional PEM-encoded certificate chain
 * @returns Combined PEM string
 */
export function combinePemCertificateAndKey(
  certificatePem: string,
  privateKeyPem: string,
  chainPem?: string,
): string {
  let combined = certificatePem;

  // Add chain if provided
  if (chainPem) {
    combined += "\n" + chainPem;
  }

  // Add private key
  combined += "\n" + privateKeyPem;

  return combined;
}

/**
 * Verify certificate and private key match
 *
 * @param certificatePem - PEM-encoded certificate
 * @param privateKeyPem - PEM-encoded private key
 * @returns true if they match, false otherwise
 */
export function verifyCertificateKeyPair(certificatePem: string, privateKeyPem: string): boolean {
  try {
    const cert = forge.pki.certificateFromPem(certificatePem);
    const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);

    // Get public key from certificate
    const publicKey = cert.publicKey as forge.pki.rsa.PublicKey;

    // Compare public key modulus with private key modulus
    const publicModulus = (publicKey as any).n.toString(16);
    const privateModulus = (privateKey as any).n.toString(16);

    return publicModulus === privateModulus;
  } catch {
    return false;
  }
}

/**
 * Extract domains from certificate (CN and SANs)
 *
 * @param certificatePem - PEM-encoded certificate
 * @returns Array of domain names
 */
export function extractDomainsFromCertificate(certificatePem: string): string[] {
  try {
    const cert = forge.pki.certificateFromPem(certificatePem);
    const domains: string[] = [];

    // Get CN from subject
    const subjectCN = cert.subject.getField("CN");
    if (subjectCN) {
      domains.push(subjectCN.value);
    }

    // Get SANs (Subject Alternative Names)
    const sanExtension = cert.getExtension("subjectAltName");
    if (sanExtension && (sanExtension as any).altNames) {
      const altNames = (sanExtension as any).altNames as Array<{ type: number; value: string }>;

      // Type 2 is DNS name
      altNames
        .filter((alt) => alt.type === 2)
        .forEach((alt) => {
          if (!domains.includes(alt.value)) {
            domains.push(alt.value);
          }
        });
    }

    return domains;
  } catch (error) {
    throw new Error(`Failed to extract domains from certificate: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * Check if certificate is expired
 *
 * @param certificatePem - PEM-encoded certificate
 * @returns true if expired, false otherwise
 */
export function isCertificateExpired(certificatePem: string): boolean {
  try {
    const cert = forge.pki.certificateFromPem(certificatePem);
    const now = new Date();

    return now > cert.validity.notAfter || now < cert.validity.notBefore;
  } catch {
    return true; // Consider invalid certificates as expired
  }
}

/**
 * Calculate days until certificate expiry
 *
 * @param certificatePem - PEM-encoded certificate
 * @returns Number of days until expiry (negative if expired)
 */
export function daysUntilExpiry(certificatePem: string): number {
  try {
    const cert = forge.pki.certificateFromPem(certificatePem);
    const now = new Date();
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysRemaining = Math.floor((cert.validity.notAfter.getTime() - now.getTime()) / msPerDay);

    return daysRemaining;
  } catch {
    return -1; // Return -1 for invalid certificates
  }
}

/**
 * Format certificate information for display
 *
 * @param certificatePem - PEM-encoded certificate
 * @returns Formatted certificate information
 */
export async function formatCertificateInfo(certificatePem: string): Promise<string> {
  try {
    const certInfo = await parseCertificate(certificatePem);
    const domains = extractDomainsFromCertificate(certificatePem);
    const days = daysUntilExpiry(certificatePem);

    return `
Certificate Information:
-----------------------
Subject: ${certInfo.subject}
Issuer: ${certInfo.issuer}
Serial Number: ${certInfo.serialNumber}
Domains: ${domains.join(", ")}
Valid From: ${certInfo.notBefore.toISOString()}
Valid Until: ${certInfo.notAfter.toISOString()}
Days Until Expiry: ${days}
Fingerprint (SHA-256): ${certInfo.fingerprint}
    `.trim();
  } catch (error) {
    throw new Error(`Failed to format certificate info: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
