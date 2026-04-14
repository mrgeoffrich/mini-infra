import { AcmeClient } from "../client";
import { Authorization, Challenge } from "../types";
import { verifyDnsChallenge, DnsResolver } from "./verify";

export interface AutoOptions {
  csr: Buffer | string;
  domains: string[];
  termsOfServiceAgreed?: boolean;
  email?: string;
  challengePriority?: string[];
  skipChallengeVerification?: boolean;
  dnsResolver?: DnsResolver;
  challengeCreateFn: (authz: Authorization, challenge: Challenge, keyAuthorization: string) => Promise<void>;
  challengeRemoveFn: (authz: Authorization, challenge: Challenge, keyAuthorization: string) => Promise<void>;
}

const selectChallenge = (challenges: Challenge[], priority: string[]): Challenge | undefined => {
  return [...challenges].sort((a, b) => {
    const ai = priority.indexOf(a.type);
    const bi = priority.indexOf(b.type);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  })[0];
};

export const auto = async (client: AcmeClient, opts: AutoOptions): Promise<string> => {
  const priority = opts.challengePriority ?? ["dns-01"];

  if (!client.hasAccount()) {
    const contact = opts.email ? [`mailto:${opts.email}`] : undefined;
    await client.createAccount({ termsOfServiceAgreed: opts.termsOfServiceAgreed ?? false, contact });
  }

  const csrBuffer = Buffer.isBuffer(opts.csr) ? opts.csr : Buffer.from(opts.csr);
  const identifiers = Array.from(new Set(opts.domains)).map((value) => ({ type: "dns" as const, value }));

  const order = await client.createOrder(identifiers);
  const authorizations = await client.getAuthorizations(order);

  const work = authorizations.map(async (authz) => {
    if (authz.status === "valid") return;
    const challenge = selectChallenge(authz.challenges, priority);
    if (!challenge) {
      throw new Error(`No suitable challenge for ${authz.identifier.value}`);
    }
    const keyAuthorization = client.getChallengeKeyAuthorization(challenge);

    await opts.challengeCreateFn(authz, challenge, keyAuthorization);
    try {
      if (!opts.skipChallengeVerification && challenge.type === "dns-01") {
        await verifyDnsChallenge(authz, challenge, keyAuthorization, opts.dnsResolver);
      }
      await client.completeChallenge(challenge);
      await client.waitForValidStatus(challenge.url);
    } finally {
      try {
        await opts.challengeRemoveFn(authz, challenge, keyAuthorization);
      } catch {
        // challengeRemoveFn errors are suppressed; cleanup is best-effort.
      }
    }
  });

  await Promise.all(work);

  const finalized = await client.finalizeOrder(order, csrBuffer);
  return client.getCertificate(finalized);
};
