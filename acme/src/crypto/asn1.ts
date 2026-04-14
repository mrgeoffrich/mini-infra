const encodeLength = (len: number): Buffer => {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

const tlv = (tag: number, value: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);

export const sequence = (...children: Buffer[]): Buffer =>
  tlv(0x30, Buffer.concat(children));

export const set = (...children: Buffer[]): Buffer =>
  tlv(0x31, Buffer.concat(children));

export const integer = (value: number | bigint | Buffer): Buffer => {
  if (Buffer.isBuffer(value)) {
    let bytes = value;
    if (bytes.length === 0) bytes = Buffer.from([0]);
    else if (bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return tlv(0x02, bytes);
  }
  const n = typeof value === "bigint" ? value : BigInt(value);
  if (n === 0n) return tlv(0x02, Buffer.from([0]));
  const out: number[] = [];
  let v = n < 0n ? -n : n;
  while (v > 0n) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  if (out[0]! & 0x80) out.unshift(0);
  return tlv(0x02, Buffer.from(out));
};

export const nullValue = (): Buffer => Buffer.from([0x05, 0x00]);

export const oid = (value: string): Buffer => {
  const parts = value.split(".").map((p) => parseInt(p, 10));
  if (parts.length < 2) throw new Error(`Invalid OID: ${value}`);
  const first = parts[0]! * 40 + parts[1]!;
  const bytes: number[] = [first];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i]!;
    if (v < 0x80) {
      bytes.push(v);
      continue;
    }
    const encoded: number[] = [v & 0x7f];
    v >>>= 7;
    while (v > 0) {
      encoded.unshift((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    bytes.push(...encoded);
  }
  return tlv(0x06, Buffer.from(bytes));
};

export const octetString = (value: Buffer): Buffer => tlv(0x04, value);

export const bitString = (value: Buffer, unusedBits = 0): Buffer =>
  tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), value]));

export const ia5String = (value: string): Buffer =>
  tlv(0x16, Buffer.from(value, "ascii"));

export const contextSpecific = (tagNumber: number, constructed: boolean, value: Buffer): Buffer => {
  const tag = 0x80 | (constructed ? 0x20 : 0) | (tagNumber & 0x1f);
  return tlv(tag, value);
};

export const raw = (value: Buffer): Buffer => value;
