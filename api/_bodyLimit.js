/**
 * _bodyLimit.js — Request body size enforcement
 *
 * IMPORTANT: Vercel serverless functions have a hard 4.5MB body limit.
 * Requests exceeding this are rejected by Vercel before our code runs,
 * returning a non-JSON response. Our own limit is set to 4MB to ensure
 * we catch oversized requests first with a friendly error message.
 *
 * Base64 encoding adds ~33% overhead — a 3MB image becomes ~4MB base64.
 * Advise Michael to resize photos to under 2MB before uploading to stay
 * well within limits.
 *
 * Limits per endpoint:
 *   /api/login                →  1kb
 *   /api/add-painting         →  4mb  (base64 image — Vercel hard cap is 4.5MB)
 *   /api/update-painting      →  4mb
 *   /api/update-artist-photo  →  4mb
 *   /api/delete-painting      →  1kb
 *   /api/toggle-sold          →  1kb
 *   /api/create-payment       →  10kb
 *   /api/postage              →  1kb
 *   /api/contact              →  5kb
 */

const UNITS = { b: 1, kb: 1024, mb: 1024 * 1024 };

function parseSize(str) {
  const match = String(str).toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb)$/);
  if (!match) throw new Error(`Invalid size format: ${str}`);
  return Math.floor(parseFloat(match[1]) * UNITS[match[2]]);
}

function estimateBodyBytes(req) {
  if (!req.body) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(req.body), 'utf8');
  } catch {
    return 0;
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  if (bytes >= 1024)        return (bytes / 1024).toFixed(0) + 'KB';
  return bytes + 'B';
}

/**
 * Checks whether the request body is within the allowed size.
 * Returns { ok: true } or { ok: false, error: string }.
 */
export function checkBodySize(req, maxSize) {
  const limitBytes = parseSize(maxSize);
  const bodyBytes  = estimateBodyBytes(req);

  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  const reportedBytes = contentLength > 0 ? contentLength : bodyBytes;

  if (reportedBytes > limitBytes) {
    const actual = formatBytes(reportedBytes);
    const limit  = formatBytes(limitBytes);
    return {
      ok:    false,
      error: `The file is too large (${actual}). Maximum allowed size is ${limit}. Please resize the image to under 2MB and try again.`,
      bytes: reportedBytes,
      limitBytes,
    };
  }

  return { ok: true, bytes: bodyBytes, limitBytes };
}
