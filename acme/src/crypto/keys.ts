import { generateKeyPair, createPublicKey, createPrivateKey as nodeCreatePrivateKey, KeyObject } from "node:crypto";
import { promisify } from "node:util";

const generateKeyPairAsync = promisify(generateKeyPair);

export const createPrivateRsaKey = async (modulusLength = 2048): Promise<Buffer> => {
  const { privateKey } = await generateKeyPairAsync("rsa", {
    modulusLength,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return Buffer.from(privateKey);
};

export const createPrivateKey = createPrivateRsaKey;

export const loadPrivateKey = (keyPem: Buffer | string): KeyObject => {
  return nodeCreatePrivateKey(keyPem);
};

export const assertRsaKey = (key: KeyObject): void => {
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error(
      `@mini-infra/acme supports only RSA keys for now, got: ${key.asymmetricKeyType ?? "unknown"}`
    );
  }
};

export const getPublicKeyObject = (keyPem: Buffer | string): KeyObject => createPublicKey(keyPem);
