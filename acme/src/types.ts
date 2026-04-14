export interface Identifier {
  type: "dns";
  value: string;
}

export type ChallengeType = "dns-01" | "http-01" | "tls-alpn-01";

export type ChallengeStatus = "pending" | "processing" | "valid" | "invalid";

export interface Challenge {
  type: ChallengeType | string;
  url: string;
  status: ChallengeStatus;
  token: string;
  validated?: string;
  error?: unknown;
}

export type AuthorizationStatus = "pending" | "valid" | "invalid" | "deactivated" | "expired" | "revoked";

export interface Authorization {
  url: string;
  identifier: Identifier;
  status: AuthorizationStatus;
  expires?: string;
  challenges: Challenge[];
  wildcard?: boolean;
}

export type OrderStatus = "pending" | "ready" | "processing" | "valid" | "invalid";

export interface Order {
  url: string;
  status: OrderStatus;
  expires?: string;
  identifiers: Identifier[];
  authorizations: string[];
  finalize: string;
  certificate?: string;
  notBefore?: string;
  notAfter?: string;
  error?: unknown;
}

export interface Account {
  url: string;
  status: "valid" | "deactivated" | "revoked";
  contact?: string[];
  termsOfServiceAgreed?: boolean;
  orders?: string;
  termsOfService?: string;
}

export interface DirectoryMeta {
  termsOfService?: string;
  website?: string;
  caaIdentities?: string[];
  externalAccountRequired?: boolean;
}

export interface Directory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  revokeCert: string;
  keyChange?: string;
  meta?: DirectoryMeta;
  [key: string]: unknown;
}
