import { createSign, generateKeyPairSync, createPublicKey } from "node:crypto";
import * as asn1 from "./asn1";
import { encodePem } from "./pem";

const SAN_OID = "2.5.29.17";
const EXTENSION_REQUEST_OID = "1.2.840.113549.1.9.14";
const SHA256_WITH_RSA_OID = "1.2.840.113549.1.1.11";

const subjectAltNameExtension = (altNames: string[]): Buffer => {
  const generalNames = altNames.map((name) => {
    // GeneralName CHOICE dNSName [2] IMPLICIT IA5String
    return asn1.contextSpecific(2, false, Buffer.from(name, "ascii"));
  });
  const sanValue = asn1.sequence(...generalNames);

  // Extension ::= SEQUENCE { extnID OID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING }
  return asn1.sequence(asn1.oid(SAN_OID), asn1.octetString(sanValue));
};

const extensionRequestAttribute = (altNames: string[]): Buffer => {
  const extensions = asn1.sequence(subjectAltNameExtension(altNames));
  // Attribute ::= SEQUENCE { type OID, values SET OF ANY }
  return asn1.sequence(asn1.oid(EXTENSION_REQUEST_OID), asn1.set(extensions));
};

export interface CsrResult {
  privateKeyPem: Buffer;
  csrPem: Buffer;
  csrDer: Buffer;
}

export const createCsr = (opts: { altNames: string[]; keySize?: number; privateKeyPem?: Buffer | string }): CsrResult => {
  const altNames = opts.altNames;
  if (!altNames || altNames.length === 0) {
    throw new Error("createCsr requires at least one altName");
  }

  let privateKeyPem: string;
  if (opts.privateKeyPem) {
    privateKeyPem = Buffer.isBuffer(opts.privateKeyPem) ? opts.privateKeyPem.toString("utf8") : opts.privateKeyPem;
  } else {
    const pair = generateKeyPairSync("rsa", {
      modulusLength: opts.keySize ?? 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    privateKeyPem = pair.privateKey;
  }

  const publicKeySpkiDer = createPublicKey(privateKeyPem).export({ type: "spki", format: "der" }) as Buffer;

  // CertificationRequestInfo ::= SEQUENCE {
  //   version INTEGER (0),
  //   subject Name,
  //   subjectPKInfo SubjectPublicKeyInfo,
  //   attributes [0] IMPLICIT SET OF Attribute
  // }
  const subject = asn1.sequence(); // empty RDN sequence
  const attributes = asn1.contextSpecific(0, true, extensionRequestAttribute(altNames));
  const certificationRequestInfo = asn1.sequence(
    asn1.integer(0),
    subject,
    asn1.raw(publicKeySpkiDer),
    attributes
  );

  const signer = createSign("SHA256");
  signer.update(certificationRequestInfo);
  const signature = signer.sign(privateKeyPem);

  const signatureAlgorithm = asn1.sequence(asn1.oid(SHA256_WITH_RSA_OID), asn1.nullValue());
  const csrDer = asn1.sequence(certificationRequestInfo, signatureAlgorithm, asn1.bitString(signature));

  const csrPem = encodePem("CERTIFICATE REQUEST", csrDer);

  return {
    privateKeyPem: Buffer.from(privateKeyPem),
    csrPem: Buffer.from(csrPem),
    csrDer,
  };
};

// acme-client compatibility helper: returns [privateKey, csrPem].
export const createCsrPair = async (
  data: { altNames: string[]; keySize?: number },
  keyPem: Buffer | string | null = null
): Promise<[Buffer, Buffer]> => {
  const result = createCsr({
    altNames: data.altNames,
    keySize: data.keySize,
    privateKeyPem: keyPem ?? undefined,
  });
  return [result.privateKeyPem, result.csrPem];
};
