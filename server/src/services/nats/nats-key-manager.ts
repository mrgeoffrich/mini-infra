// Operator/account/user NKey + JWT primitives for NATS.
//
// Mirrors the slackbot-agent-sdk approach: an operator NKey signs an account
// JWT, the account NKey signs user JWTs, and `.creds` files combine a user
// JWT with the user NKey seed. NATS clients use those `.creds` to authenticate.
//
// The operator and account NKey *seeds* are the only true secrets — they
// stay in Vault. Operator/account JWTs are public (they're embedded in
// nats.conf and visible to any NATS client). User JWTs are short-lived and
// scoped to a permission allow-list passed in by the caller.

import {
  createOperator,
  createAccount,
  createUser,
  fromSeed,
  type KeyPair,
} from "nkeys.js";
import { encodeOperator, encodeAccount, encodeUser, fmtCreds } from "nats-jwt";

export interface NatsPermissions {
  pub: string[];
  sub: string[];
}

export interface OperatorMaterial {
  seed: string;
  publicKey: string;
  jwt: string;
}

export interface AccountMaterial {
  seed: string;
  publicKey: string;
  jwt: string;
}

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

/**
 * Wide-open account limits. We use NATS auth to scope individual users via
 * pub/sub allow-lists; account-level caps would just add noise here.
 */
const DEFAULT_ACCOUNT_LIMITS = {
  conn: -1,
  subs: -1,
  data: -1,
  payload: -1,
  imports: -1,
  exports: -1,
  wildcards: true,
  leaf: -1,
  disallow_bearer: false,
};

/** Decode an NKey seed string into a KeyPair. */
export function loadKeyPair(seed: string): KeyPair {
  return fromSeed(TEXT_ENCODER.encode(seed));
}

/** Generate a fresh operator key pair and sign its JWT. */
export async function generateOperator(name: string): Promise<OperatorMaterial> {
  const kp = createOperator();
  const seed = TEXT_DECODER.decode(kp.getSeed());
  const publicKey = kp.getPublicKey();
  const jwt = await encodeOperator(name, kp);
  return { seed, publicKey, jwt };
}

/** Re-sign an existing operator's JWT (e.g. after restart from a stored seed). */
export async function reissueOperatorJwt(
  name: string,
  operatorSeed: string,
): Promise<OperatorMaterial> {
  const kp = loadKeyPair(operatorSeed);
  const publicKey = kp.getPublicKey();
  const jwt = await encodeOperator(name, kp);
  return { seed: operatorSeed, publicKey, jwt };
}

/** Generate a fresh account key pair and sign its JWT with the operator. */
export async function generateAccount(
  name: string,
  operatorKp: KeyPair,
): Promise<AccountMaterial> {
  const kp = createAccount();
  const seed = TEXT_DECODER.decode(kp.getSeed());
  const publicKey = kp.getPublicKey();
  const jwt = await encodeAccount(
    name,
    kp,
    { limits: DEFAULT_ACCOUNT_LIMITS },
    { signer: operatorKp },
  );
  return { seed, publicKey, jwt };
}

/** Re-sign an existing account's JWT from its stored seed. */
export async function reissueAccountJwt(
  name: string,
  accountSeed: string,
  operatorKp: KeyPair,
): Promise<AccountMaterial> {
  const kp = loadKeyPair(accountSeed);
  const publicKey = kp.getPublicKey();
  const jwt = await encodeAccount(
    name,
    kp,
    { limits: DEFAULT_ACCOUNT_LIMITS },
    { signer: operatorKp },
  );
  return { seed: accountSeed, publicKey, jwt };
}

/**
 * Mint a `.creds` string for a NATS client. The user JWT is signed by the
 * account, scoped to the supplied permissions, and expires after `ttlSeconds`.
 * Pass `0` for `ttlSeconds` to mint a non-expiring JWT.
 */
export async function mintUserCreds(
  name: string,
  accountKp: KeyPair,
  perms: NatsPermissions,
  ttlSeconds: number,
): Promise<string> {
  const userKp = createUser();
  const opts: { exp?: number } = {};
  if (ttlSeconds > 0) {
    opts.exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  }
  const jwt = await encodeUser(
    name,
    userKp,
    accountKp,
    {
      pub: { allow: perms.pub, deny: [] },
      sub: { allow: perms.sub, deny: [] },
    },
    opts,
  );
  return TEXT_DECODER.decode(fmtCreds(jwt, userKp));
}
