/**
 * Lightweight ANSI escape code to HTML converter.
 * Replaces the `ansi-to-html` npm package with only the subset we need
 * (standard 8/16 colors, bold, dim, italic, underline, reset).
 */

const ANSI_COLORS: Record<number, string> = {
  30: "#000",
  31: "#c00",
  32: "#0a0",
  33: "#c50",
  34: "#00c",
  35: "#c0c",
  36: "#0cc",
  37: "#ccc",
  // Bright variants
  90: "#555",
  91: "#f55",
  92: "#5f5",
  93: "#ff5",
  94: "#55f",
  95: "#f5f",
  96: "#5ff",
  97: "#fff",
};

const ANSI_BG_COLORS: Record<number, string> = {
  40: "#000",
  41: "#c00",
  42: "#0a0",
  43: "#c50",
  44: "#00c",
  45: "#c0c",
  46: "#0cc",
  47: "#ccc",
  100: "#555",
  101: "#f55",
  102: "#5f5",
  103: "#ff5",
  104: "#55f",
  105: "#f5f",
  106: "#5ff",
  107: "#fff",
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// Matches an ANSI escape sequence: ESC[ followed by semicolon-separated numbers and a letter
const ANSI_RE = /\x1b\[([0-9;]*)m/g;

export function ansiToHtml(input: string): string {
  let result = "";
  let lastIndex = 0;
  let openSpans = 0;

  let match: RegExpExecArray | null;
  while ((match = ANSI_RE.exec(input)) !== null) {
    // Append escaped text before this match
    if (match.index > lastIndex) {
      result += escapeHtml(input.slice(lastIndex, match.index));
    }
    lastIndex = match.index + match[0].length;

    const codes = match[1]
      ? match[1].split(";").map(Number)
      : [0];

    for (const code of codes) {
      if (code === 0) {
        // Reset — close all open spans
        while (openSpans > 0) {
          result += "</span>";
          openSpans--;
        }
      } else {
        const styles: string[] = [];
        if (code === 1) styles.push("font-weight:bold");
        else if (code === 2) styles.push("opacity:0.7");
        else if (code === 3) styles.push("font-style:italic");
        else if (code === 4) styles.push("text-decoration:underline");
        else if (ANSI_COLORS[code]) styles.push(`color:${ANSI_COLORS[code]}`);
        else if (ANSI_BG_COLORS[code]) styles.push(`background-color:${ANSI_BG_COLORS[code]}`);

        if (styles.length > 0) {
          result += `<span style="${styles.join(";")}">`
          openSpans++;
        }
      }
    }
  }

  // Append any remaining text after the last match
  if (lastIndex < input.length) {
    result += escapeHtml(input.slice(lastIndex));
  }

  // Close any unclosed spans
  while (openSpans > 0) {
    result += "</span>";
    openSpans--;
  }

  return result;
}
