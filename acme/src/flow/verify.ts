import { promises as dns } from "node:dns";
import { Authorization, Challenge } from "../types";

export interface DnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
  resolveCname(hostname: string): Promise<string[]>;
}

const walkDnsChallengeRecord = async (recordName: string, resolver: DnsResolver): Promise<string[]> => {
  try {
    const cnames = await resolver.resolveCname(recordName);
    if (cnames.length) {
      return walkDnsChallengeRecord(cnames[0]!, resolver);
    }
  } catch {
    // No CNAME records — fall through to TXT lookup.
  }

  const txt = await resolver.resolveTxt(recordName);
  return txt.flat();
};

export const verifyDnsChallenge = async (
  authz: Authorization,
  _challenge: Challenge,
  keyAuthorization: string,
  resolver: DnsResolver = dns
): Promise<boolean> => {
  const recordName = `_acme-challenge.${authz.identifier.value}`;
  const values = await walkDnsChallengeRecord(recordName, resolver);
  if (!values.includes(keyAuthorization)) {
    throw new Error(`Authorization not found in DNS TXT record: ${recordName}`);
  }
  return true;
};
