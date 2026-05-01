/**
 * Drive folder id parsing helper. Accepts:
 *   - a raw folder id (alphanumeric + `_`/`-`, ≥8 chars)
 *   - a Drive folder URL (`https://drive.google.com/drive/folders/<id>` or
 *     `.../drive/u/0/folders/<id>?…`)
 * Returns null if neither form matches.
 */
const FOLDER_ID_REGEX = /^[A-Za-z0-9_-]{8,}$/;

export function extractGoogleDriveFolderId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (FOLDER_ID_REGEX.test(trimmed)) return trimmed;
  const match = trimmed.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (match) return match[1];
  return null;
}
