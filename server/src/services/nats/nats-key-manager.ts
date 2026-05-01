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
import {
  encodeOperator,
  encodeAccount,
  encodeUser,
  fmtCreds,
  newScopedSigner,
  type SigningKey,
} from "nats-jwt";

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
  signingKeys: SigningKey[] = [],
): Promise<AccountMaterial> {
  const kp = createAccount();
  const seed = TEXT_DECODER.decode(kp.getSeed());
  const publicKey = kp.getPublicKey();
  const jwt = await encodeAccount(
    name,
    kp,
    { limits: DEFAULT_ACCOUNT_LIMITS, signing_keys: signingKeys },
    { signer: operatorKp },
  );
  return { seed, publicKey, jwt };
}

/**
 * Re-sign an existing account's JWT from its stored seed. Accepts an optional
 * list of scoped signing keys (Phase 4) — these are spliced into the account
 * claims so NATS will trim user JWTs minted by them to the declared subject
 * scope. The list fully replaces any prior signing keys.
 */
export async function reissueAccountJwt(
  name: string,
  accountSeed: string,
  operatorKp: KeyPair,
  signingKeys: SigningKey[] = [],
): Promise<AccountMaterial> {
  const kp = loadKeyPair(accountSeed);
  const publicKey = kp.getPublicKey();
  const jwt = await encodeAccount(
    name,
    kp,
    { limits: DEFAULT_ACCOUNT_LIMITS, signing_keys: signingKeys },
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

/**
 * Mint a long-lived `.creds` for a system-account user. Used by the control
 * plane to publish `$SYS.REQ.CLAIMS.UPDATE` requests. Permissions are broad
 * because the system account is the only entity allowed to push account
 * claims, and constraining further would just block the very purpose of
 * minting it.
 */
export async function mintSystemUserCreds(
  systemAccountKp: KeyPair,
): Promise<string> {
  return mintUserCreds(
    "mini-infra-system-admin",
    systemAccountKp,
    { pub: ["$SYS.>"], sub: ["$SYS.>", "_INBOX.>"] },
    0,
  );
}

export interface ScopedSigningKeyMaterial {
  seed: string;
  publicKey: string;
  /** Splice this into the account JWT's `signing_keys` claim to activate
   *  the scope. Re-issuing the account JWT and propagating it via
   *  `$SYS.REQ.CLAIMS.UPDATE` is what makes the scope take effect. */
  scopeTemplate: SigningKey;
}

/**
 * Generate a fresh ED25519 account-signing key bound to a specific subject
 * scope. The returned `scopeTemplate` carries the public key + a permission
 * envelope that NATS server uses to *trim* any user JWT minted by this key:
 * even if the application asks for broader pub/sub permissions, the server
 * will silently strip them down to `<scopedSubject>` (plus `_INBOX.>` for
 * request/reply). This is the load-bearing cryptographic guarantee Phase 4
 * gives third-party apps — they hold the seed but cannot issue tokens that
 * exceed the declared scope.
 */
export function generateScopedSigningKey({
  role,
  scopedSubject,
}: {
  role: string;
  scopedSubject: string;
}): ScopedSigningKeyMaterial {
  // Account-prefix nkey — scoped signing keys are added to the parent
  // account's `signing_keys` and used to sign user JWTs in that account's
  // namespace.
  const kp = createAccount();
  const seed = TEXT_DECODER.decode(kp.getSeed());
  const publicKey = kp.getPublicKey();
  const scopeTemplate = newScopedSigner(kp, role, {
    pub: { allow: [scopedSubject], deny: [] },
    sub: { allow: [scopedSubject, "_INBOX.>"], deny: [] },
  });
  return { seed, publicKey, scopeTemplate };
}
