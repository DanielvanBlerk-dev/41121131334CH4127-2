/**
 * _imageValidator.js — Server-side image validation
 *
 * Validates that an uploaded image is:
 *   1. Actually an image (magic byte check — cannot be spoofed by renaming)
 *   2. A permitted format (JPEG, PNG, WEBP, GIF — SVG explicitly blocked)
 *   3. Within the maximum allowed decoded size
 *
 * SVG is blocked entirely because it is XML and can contain
 * embedded <script> tags, <foreignObject>, and event handlers
 * (onload, onerror etc.) that execute in the browser.
 *
 * Magic bytes reference:
 *   JPEG  → FF D8 FF
 *   PNG   → 89 50 4E 47 0D 0A 1A 0A
 *   WEBP  → 52 49 46 46 ... 57 45 42 50
 *   GIF   → 47 49 46 38 (GIF8)
 */

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB decoded

const SIGNATURES = [
  {
    format: 'image/jpeg',
    // FF D8 FF
    check: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  },
  {
    format: 'image/png',
    // 89 50 4E 47 0D 0A 1A 0A
    check: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
      b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A,
  },
  {
    format: 'image/webp',
    // RIFF....WEBP  (bytes 0-3 = 52 49 46 46, bytes 8-11 = 57 45 42 50)
    check: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  {
    format: 'image/gif',
    // GIF87a or GIF89a
    check: (b) =>
      b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61,
  },
];

/**
 * Strips the data URI prefix from a base64 string if present.
 * e.g. "data:image/jpeg;base64,/9j/4AA..." → "/9j/4AA..."
 */
function stripDataUri(dataUri) {
  if (!dataUri) return null;
  const commaIdx = dataUri.indexOf(',');
  if (commaIdx !== -1) return dataUri.slice(commaIdx + 1);
  return dataUri;
}

/**
 * Extracts the declared MIME type from a data URI prefix.
 * e.g. "data:image/jpeg;base64,..." → "image/jpeg"
 * Returns null if no data URI prefix present.
 */
function extractDeclaredMime(dataUri) {
  const match = dataUri.match(/^data:([^;]+);base64,/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Validates a base64-encoded image string.
 *
 * @param {string} imgData  - raw base64 string or data URI
 * @returns {{ ok: boolean, error?: string, format?: string }}
 */
export function validateImage(imgData) {
  if (!imgData || typeof imgData !== 'string') {
    return { ok: false, error: 'No image data provided.' };
  }

  // ── Block SVG at declaration level ────────────────────────────────────
  // Even before decoding — if the client declares SVG, reject immediately.
  const declaredMime = extractDeclaredMime(imgData);
  if (declaredMime && (declaredMime === 'image/svg+xml' || declaredMime.includes('svg'))) {
    return { ok: false, error: 'SVG images are not permitted for security reasons. Please upload a JPEG, PNG, WEBP, or GIF.' };
  }

  // ── Decode base64 ─────────────────────────────────────────────────────
  const base64 = stripDataUri(imgData);
  if (!base64) {
    return { ok: false, error: 'Invalid image data.' };
  }

  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    return { ok: false, error: 'Image data could not be decoded.' };
  }

  // ── Size check ────────────────────────────────────────────────────────
  if (buffer.length > MAX_IMAGE_BYTES) {
    const mb = (buffer.length / (1024 * 1024)).toFixed(1);
    return {
      ok:    false,
      error: `Image is too large (${mb}MB). Maximum allowed size is ${MAX_IMAGE_BYTES / (1024 * 1024)}MB.`,
    };
  }

  if (buffer.length < 12) {
    return { ok: false, error: 'Image file is too small to be valid.' };
  }

  // ── Magic byte check ──────────────────────────────────────────────────
  // Read the first 12 bytes — enough to identify any supported format.
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, Math.min(12, buffer.length));

  // Explicitly reject SVG at the byte level too.
  // SVG files start with "<?xml" or "<svg" in ASCII.
  const head = buffer.slice(0, 16).toString('ascii').toLowerCase().trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!doctype svg')) {
    return { ok: false, error: 'SVG images are not permitted for security reasons.' };
  }

  const match = SIGNATURES.find(sig => sig.check(bytes));
  if (!match) {
    return {
      ok:    false,
      error: 'Unrecognised image format. Please upload a JPEG, PNG, WEBP, or GIF.',
    };
  }

  // ── Cross-check declared vs actual MIME ───────────────────────────────
  // If the client declared a MIME type, it must match what we detected.
  // Mismatch = the file was renamed or tampered with.
  if (declaredMime && declaredMime !== match.format) {
    return {
      ok:    false,
      error: `Image type mismatch. File appears to be ${match.format} but was declared as ${declaredMime}.`,
    };
  }

  return { ok: true, format: match.format };
}
