import { db, assertPersistentStorage } from "./db";
import { PART_BYTES } from "./db/supabase-repo";
import { httpError } from "./http";

/**
 * Shared, stateless, 413-proof recording upload used by PKT proctoring
 * recordings (camera / screen). Same protocol as the voice certification:
 *   plan  -> signed per-part URLs (direct to storage) or relay part size
 *   part  -> one small part per request (<= 4 MB, Vercel-safe)
 *   verify-> stored byte count must equal the recording size
 */
const MIN_PART_BYTES = 64 * 1024;
const RELAY_DEFAULT_BYTES = 1024 * 1024;
export const RELAY_MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECORDING_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_PARTS = 20000;

export async function planRecordingUpload(key, kind, body) {
  assertPersistentStorage();
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) throw httpError("size is required", 400);
  if (size > MAX_RECORDING_BYTES) throw httpError("Recording is larger than 4 GB.", 400);
  const wantDirect = body.direct !== false;
  const ceiling = wantDirect ? PART_BYTES : RELAY_MAX_BYTES;
  const requested = Number(body.part_size);
  let partSize = Math.round(Math.max(MIN_PART_BYTES, Math.min(ceiling, Number.isFinite(requested) && requested > 0 ? requested : wantDirect ? PART_BYTES : RELAY_DEFAULT_BYTES)));
  if (Math.ceil(size / partSize) > MAX_PARTS) partSize = Math.ceil(size / MAX_PARTS);
  const count = Math.max(1, Math.ceil(size / partSize));
  await db.clearRecordingParts(key, kind);
  let parts = null;
  if (wantDirect) {
    try {
      parts = await db.createRecordingPartUrls(key, kind, count);
    } catch (err) {
      console.warn(`[upload-url] signed URLs unavailable for ${key}/${kind}: ${err.message}`);
    }
  }
  const direct = Array.isArray(parts) && parts.length === count;
  return { mode: direct ? "direct" : "relay", part_size: partSize, count, parts: direct ? parts : null, relay_part_size: Math.min(partSize, RELAY_MAX_BYTES), relay_max_bytes: RELAY_MAX_BYTES };
}

export async function storeRecordingPart(key, kind, request) {
  assertPersistentStorage();
  const index = Number(new URL(request.url).searchParams.get("index"));
  if (!Number.isInteger(index) || index < 0 || index >= MAX_PARTS) throw httpError("Invalid part index", 400);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RELAY_MAX_BYTES) throw httpError(`Part too large (max ${RELAY_MAX_BYTES} bytes)`, 413);
  const buffer = Buffer.from(await request.arrayBuffer());
  if (!buffer.length) throw httpError("Empty part", 400);
  if (buffer.length > RELAY_MAX_BYTES) throw httpError(`Part too large (max ${RELAY_MAX_BYTES} bytes)`, 413);
  return db.saveRecordingPart(key, kind, index, buffer);
}

export async function verifyRecordingUpload(key, kind, totalSize) {
  const info = await db.getRecordingObjectInfo(key, kind);
  if (!info) throw httpError("The uploaded recording was not found in storage. Please retry the upload.", 400);
  const expected = Number(totalSize);
  if (Number.isFinite(expected) && expected > 0 && info.size_bytes !== expected) {
    throw httpError(`Uploaded recording is incomplete (${info.size_bytes} of ${expected} bytes stored). Please retry the upload.`, 400);
  }
  return info;
}
