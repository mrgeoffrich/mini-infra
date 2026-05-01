#!/usr/bin/env node
// Streams a Drive file's content to stdout (or to a target path passed as $1).
// Used by `restore.sh` when STORAGE_PROVIDER=google-drive.
//
// Required env:
//   STORAGE_GDRIVE_ACCESS_TOKEN     short-lived OAuth access token
//   STORAGE_GDRIVE_FILE_ID          source file id (resolved server-side)
//
// Optional env:
//   STORAGE_GDRIVE_FILE_NAME        informational
//   STORAGE_GDRIVE_TOKEN_EXPIRES_AT informational
//
// Argument:
//   $1                              optional output path. When omitted, file
//                                   content is written to stdout (so the
//                                   restore script can pipe directly).

import { google } from "googleapis";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

function fail(message, code = 1) {
  console.error(`[download-google-drive] ${message}`);
  process.exit(code);
}

const accessToken = process.env.STORAGE_GDRIVE_ACCESS_TOKEN;
const fileId = process.env.STORAGE_GDRIVE_FILE_ID;
const fileName = process.env.STORAGE_GDRIVE_FILE_NAME ?? fileId;
const outputPath = process.argv[2];

if (!accessToken) fail("STORAGE_GDRIVE_ACCESS_TOKEN is required");
if (!fileId) fail("STORAGE_GDRIVE_FILE_ID is required");

console.error(
  `[download-google-drive] Streaming Drive file ${fileName} (id=${fileId})${outputPath ? ` → ${outputPath}` : " → stdout"}`,
);

const auth = new google.auth.OAuth2();
auth.setCredentials({ access_token: accessToken });
const drive = google.drive({ version: "v3", auth });

try {
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" },
  );
  const sink = outputPath ? createWriteStream(outputPath) : process.stdout;
  let bytesReceived = 0;
  res.data.on("data", (chunk) => {
    bytesReceived += chunk.length;
    if (bytesReceived % (5 * 1024 * 1024) < chunk.length) {
      console.error(
        `[download-google-drive] received ${bytesReceived} bytes`,
      );
    }
  });
  // pipeline() handles backpressure + error propagation; explicit `end` only
  // when the sink is a file stream (stdout closes itself when the process exits).
  await pipeline(res.data, sink);
  console.error(
    `[download-google-drive] Download complete (${bytesReceived} bytes)`,
  );
} catch (err) {
  const status = err?.response?.status;
  const code = err?.code;
  fail(
    `Drive download failed (status=${status ?? code ?? "?"}): ${err.message}`,
  );
}
