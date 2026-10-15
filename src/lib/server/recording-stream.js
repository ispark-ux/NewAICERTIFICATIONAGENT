import { db } from "./db";

const MAX_RANGE_BYTES = 3 * 1024 * 1024; // every response stays below serverless body limits (Vercel 4.5 MB)

/** Streams a recording stored as parts, with HTTP Range support (video seeking). */
export function streamParts(access, kind, range) {
  const mime = kind === "audio" ? "audio/webm" : "video/webm";
  const size = access.size;
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (!range && size > MAX_RANGE_BYTES) {
    end = MAX_RANGE_BYTES - 1; // large file without Range: serve the first window as 206 - players then request the rest
    status = 206;
  } else if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match && match[1] === "" && match[2]) {
      start = Math.max(0, size - parseInt(match[2], 10));
    } else {
      start = match && match[1] ? parseInt(match[1], 10) : 0;
      end = match && match[2] ? parseInt(match[2], 10) : size - 1;
    }
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= size) end = size - 1;
    if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    end = Math.min(end, start + MAX_RANGE_BYTES - 1); // a shorter 206 is valid; the player requests the rest
    status = 206;
  }
  const wanted = access.parts.filter((p) => p.offset + p.size > start && p.offset <= end);
  let i = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (i >= wanted.length) {
        controller.close();
        return;
      }
      const p = wanted[i++];
      try {
        const buf = await db.readRecordingPart(p.path);
        const from = Math.max(0, start - p.offset);
        const to = Math.min(p.size, end - p.offset + 1);
        controller.enqueue(new Uint8Array(buf.subarray(from, to)));
      } catch (err) {
        controller.error(err);
      }
    },
  });
  const headers = { "Content-Type": mime, "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return new Response(stream, { status, headers });
}

