#!/usr/bin/env node
// Streams a backup file from disk to Google Drive via Drive v3 resumable
// upload. Used by `backup.sh` when STORAGE_PROVIDER=google-drive.
//
// Required env:
//   STORAGE_GDRIVE_ACCESS_TOKEN     short-lived OAuth access token
//   STORAGE_GDRIVE_FOLDER_ID        destination Drive folder id
//   STORAGE_GDRIVE_FILE_NAME        filename to write
//   STORAGE_GDRIVE_TOKEN_EXPIRES_AT ISO timestamp; informational
//
// Optional env:
//   STORAGE_GDRIVE_MIME_TYPE        defaults to application/octet-stream
//
// Argument:
//   $1                              path to the file to upload
//
// Exits 0 on success, non-zero on any failure. Progress is written to stderr.

import { google } from "googleapis";
import { createReadStream, statSync } from "node:fs";
import { resolve } from "node:path";

function fail(message, code = 1) {
  console.error(`[upload-google-drive] ${message}`);
  process.exit(code);
}

const accessToken = process.env.STORAGE_GDRIVE_ACCESS_TOKEN;
const folderId = process.env.STORAGE_GDRIVE_FOLDER_ID;
const fileName = process.env.STORAGE_GDRIVE_FILE_NAME;
const expiresAt = process.env.STORAGE_GDRIVE_TOKEN_EXPIRES_AT;
const mimeType =
  process.env.STORAGE_GDRIVE_MIME_TYPE ?? "application/octet-stream";
const filePath = process.argv[2];

if (!accessToken) fail("STORAGE_GDRIVE_ACCESS_TOKEN is required");
if (!folderId) fail("STORAGE_GDRIVE_FOLDER_ID is required");
if (!fileName) fail("STORAGE_GDRIVE_FILE_NAME is required");
if (!filePath) fail("upload-google-drive.mjs <file-path> is required");

const absPath = resolve(filePath);
let fileSize;
try {
  fileSize = statSync(absPath).size;
} catch (err) {
  fail(`File not found: ${absPath} (${err.message})`);
}

console.error(
  `[upload-google-drive] Uploading ${absPath} (${fileSize} bytes) to folder ${folderId} as ${fileName}`,
);
if (expiresAt) {
  const remainingMs = new Date(expiresAt).getTime() - Date.now();
  console.error(
    `[upload-google-drive] Token expires at ${expiresAt} (${Math.round(remainingMs / 1000)}s remaining)`,
  );
}

const auth = new google.auth.OAuth2();
auth.setCredentials({ access_token: accessToken });
const drive = google.drive({ version: "v3", auth });

// Drive allows multiple files with the same name in the same folder. The
// server reconstructs `storageObjectUrl` as `<folderId>/<fileName>` and later
// resolves files by name (`findFileIdByName` returns `files[0]`), so a stale
// duplicate would silently shadow the new upload. Match Azure's blob-name
// uniqueness by looking up + deleting any existing file with the same name
// before uploading. Option (b) from the H4 review note.
try {
  const safeName = fileName.replace(/'/g, "\\'");
  const existing = await drive.files.list({
    q: `'${folderId}' in parents and name='${safeName}' and trashed=false`,
    fields: "files(id, name)",
    pageSize: 10,
    spaces: "drive",
  });
  for (const f of existing.data.files ?? []) {
    if (!f.id) continue;
    console.error(
      `[upload-google-drive] Removing existing Drive file ${f.id} (${f.name}) before re-upload`,
    );
    try {
      await drive.files.delete({ fileId: f.id });
    } catch (deleteErr) {
      console.error(
        `[upload-google-drive] Warning: failed to delete existing file ${f.id}: ${deleteErr.message}`,
      );
    }
  }
} catch (lookupErr) {
  console.error(
    `[upload-google-drive] Warning: existing-file lookup failed (${lookupErr.message}); proceeding with upload`,
  );
}

try {
  const stream = createReadStream(absPath);
  let bytesSent = 0;
  stream.on("data", (chunk) => {
    bytesSent += chunk.length;
    if (bytesSent % (5 * 1024 * 1024) < chunk.length) {
      const pct = fileSize ? Math.floor((bytesSent / fileSize) * 100) : 0;
      console.error(
        `[upload-google-drive] uploaded ${bytesSent}/${fileSize} bytes (${pct}%)`,
      );
    }
  });

  // googleapis automatically uses resumable upload for large bodies. Setting
  // `media.body` to a stream is enough — the library handles chunking.
  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
      mimeType,
    },
    media: {
      mimeType,
      body: stream,
    },
    fields: "id, name, size, md5Checksum",
  });

  console.error(
    `[upload-google-drive] Upload complete — drive file id ${res.data.id}, size ${res.data.size}, md5 ${res.data.md5Checksum ?? "(none)"}`,
  );
  // Print just the file id on stdout so callers can capture it easily.
  process.stdout.write(`${res.data.id}\n`);
} catch (err) {
  const status = err?.response?.status;
  const code = err?.code;
  fail(`Drive upload failed (status=${status ?? code ?? "?"}): ${err.message}`);
}
