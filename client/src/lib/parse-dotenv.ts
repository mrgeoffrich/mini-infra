export interface DotenvEntry {
  key: string;
  value: string;
}

const LINE_RE =
  /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function unquote(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if (first === '"' && last === '"') {
      return raw
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    if (first === "'" && last === "'") {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

export function parseDotenv(text: string): DotenvEntry[] {
  const seen = new Map<string, string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const match = LINE_RE.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    // Strip inline comments only when value is not quoted
    let value = rawValue;
    if (value && value[0] !== '"' && value[0] !== "'") {
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    }
    seen.set(key, unquote(value));
  }

  return Array.from(seen, ([key, value]) => ({ key, value }));
}
