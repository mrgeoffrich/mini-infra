export interface PemBlock {
  type: string;
  body: Buffer;
}

export const encodePem = (type: string, der: Buffer): string => {
  const b64 = der.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----\n`;
};

export const decodePem = (pem: string): PemBlock[] => {
  const re = /-----BEGIN ([^-]+)-----\s*([\s\S]+?)\s*-----END \1-----/g;
  const blocks: PemBlock[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(pem)) !== null) {
    blocks.push({ type: m[1]!, body: Buffer.from(m[2]!.replace(/\s+/g, ""), "base64") });
  }
  return blocks;
};

export const splitPemChain = (pem: Buffer | string): string[] => {
  const text = Buffer.isBuffer(pem) ? pem.toString("utf8") : pem;
  return decodePem(text).map((b) => encodePem(b.type, b.body));
};

export const pemToDer = (pem: Buffer | string): Buffer => {
  const text = Buffer.isBuffer(pem) ? pem.toString("utf8") : pem;
  const blocks = decodePem(text);
  if (!blocks.length) throw new Error("Unable to parse PEM body from string");
  return blocks[0]!.body;
};

export const derToB64u = (der: Buffer): string => der.toString("base64url");
