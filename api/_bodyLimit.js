/**
 * _bodyLimit.js — Request body size enforcement
 *
 * Vercel serverless functions parse the body automatically, but do not
 * enforce a size limit by default. A malicious actor could POST a very
 * large base64 image to /api/add-painting and exhaust function memory,
 * cause timeouts, or inflate Redis storage costs.
 *
 * Usage:
 *   import { checkBodySize } from './_bodyLimit.js';
 *
 *   const sizeCheck = checkBodySize(req, '5mb');
 *   if (!sizeCheck.ok) return res.status(413).json({ error: sizeCheck.error });
 *
 * Limits per endpoint:
 *   /api/login            →  1kb   (just a password string)
 *   /api/add-painting     →  5mb   (allows a base64-encoded image)
 *   /api/update-painting  →  5mb   (same — may include new image)
 *   /api/delete-painting  →  1kb   (just an id)
 *   /api/toggle-sold      →  1kb   (just an id)
 *   /api/create-payment   →  10kb  (customer fields + item list)
 */

const UNITS = { b: 1, kb: 1024, mb: 1024 * 1024 };

/**
 * Parses a human-readable size string into bytes.
 * e.g. '5mb' → 5242880,  '10kb' → 10240,  '500b' → 500
 */
function parseSize(str) {
  const match = String(str).toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb)$/);
  if (!match) throw new Error(`Invalid size format: ${str}`);
  return Math.floor(parseFloat(match[1]) * UNITS[match[2]]);
}

/**
 * Estimates the size of the parsed request body in bytes.
 *
 * Vercel provides req.body as a parsed JS object, so we can't read
 * raw Content-Length reliably — we serialise to JSON and measure that.
 * This is a conservative upper-bound (JSON.stringify adds some overhead).
 */
function estimateBodyBytes(req) {
  if (!req.body) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(req.body), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Checks whether the request body is within the allowed size.
 *
 * @param {object} req          - Vercel/Node request object
 * @param {string} maxSize      - e.g. '5mb', '10kb', '1kb'
 * @returns {{ ok: boolean, error?: string, bytes?: number, limitBytes?: number }}
 */
export function checkBodySize(req, maxSize) {
  const limitBytes = parseSize(maxSize);
  const bodyBytes  = estimateBodyBytes(req);

  // Also check Content-Length header if present — catches oversized
  // requests before the body is even parsed (belt-and-braces)
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  const reportedBytes = contentLength > 0 ? contentLength : bodyBytes;

  if (reportedBytes > limitBytes) {
    return {
      ok:         false,
      error:      `Request body too large. Maximum allowed size is ${maxSize.toUpperCase()}.`,
      bytes:      reportedBytes,
      limitBytes,
    };
  }

  return { ok: true, bytes: bodyBytes, limitBytes };
}
