import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/**
 * Admin-controlled settings for the upload-time image compression step
 * (see _imageCompress.js). Stored as a single Redis key so every route
 * that puts a photo into Vercel Blob (upload-image.js,
 * update-artist-photo.js, and the Gelato-preview import in paintings.js)
 * reads the same live settings — changing them in the admin panel takes
 * effect on the very next upload, no redeploy needed.
 *
 *   enabled           — master on/off switch. When false, uploads are
 *                        stored exactly as received.
 *   maxDimension       — longest edge, in pixels, the FULL/display version
 *                        of an uploaded image is resized down to. This is
 *                        the version the lightbox shows, and the file a
 *                        Gelato print order is built from — so it needs to
 *                        stay a real, printable/viewable size.
 *   quality             — JPEG/WEBP re-encode quality for the full version,
 *                        1-100.
 *   thumbMaxDimension  — longest edge, in pixels, of the separate small
 *                        THUMBNAIL version used only in the gallery grid.
 *                        This is what actually controls Blob Data
 *                        Transfer on a normal page view — grid cards are
 *                        a few hundred px wide, so the thumbnail can be
 *                        far smaller than the full version without any
 *                        visible loss in the grid.
 *   thumbQuality        — JPEG re-encode quality for the thumbnail, 1-100.
 *                        Can reasonably be lower than the full-size
 *                        quality since it's displayed small.
 *
 * An image already smaller than a given max dimension is never upscaled
 * — only re-compressed (see _imageCompress.js).
 *
 * This module is underscore-prefixed like the project's other shared
 * helpers (_verifyAdmin.js, _sanitize.js, etc.) — Vercel does not deploy
 * these as their own routes, so adding it costs nothing against the
 * function-count limit.
 */
const REDIS_KEY = 'image-settings';

export const DEFAULT_IMAGE_SETTINGS = Object.freeze({
  enabled:           true,
  maxDimension:      2400,
  quality:           82,
  thumbMaxDimension: 700,
  thumbQuality:      75,
});

/**
 * Reads the current settings from Redis, filling in any missing field
 * with its default — so a brand-new deployment (nothing saved yet) or a
 * partially-saved record (e.g. one saved before thumbMaxDimension/
 * thumbQuality existed) never breaks an upload.
 */
export async function getImageSettings() {
  let stored = null;
  try {
    stored = await redis.get(REDIS_KEY);
  } catch (err) {
    console.error('Failed to read image settings, using defaults:', err);
  }
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_IMAGE_SETTINGS };
  return {
    enabled:           typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULT_IMAGE_SETTINGS.enabled,
    maxDimension:      Number.isFinite(stored.maxDimension) ? stored.maxDimension : DEFAULT_IMAGE_SETTINGS.maxDimension,
    quality:           Number.isFinite(stored.quality) ? stored.quality : DEFAULT_IMAGE_SETTINGS.quality,
    thumbMaxDimension: Number.isFinite(stored.thumbMaxDimension) ? stored.thumbMaxDimension : DEFAULT_IMAGE_SETTINGS.thumbMaxDimension,
    thumbQuality:      Number.isFinite(stored.thumbQuality) ? stored.thumbQuality : DEFAULT_IMAGE_SETTINGS.thumbQuality,
  };
}

/**
 * Validates admin input before saving. Bounds are generous but not
 * unlimited — a maxDimension of 50px or a quality of 1 would be a
 * mistake, not a real setting an admin actually wants, so both are
 * rejected outright rather than silently accepted and producing
 * broken-looking listings site-wide.
 */
export function validateImageSettings(input) {
  const { enabled, maxDimension, quality, thumbMaxDimension, thumbQuality } = input || {};
  if (typeof enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be true or false.' };
  }
  const dim = Number(maxDimension);
  if (!Number.isFinite(dim) || dim < 400 || dim > 6000) {
    return { ok: false, error: 'Max dimension must be between 400 and 6000 pixels.' };
  }
  const q = Number(quality);
  if (!Number.isFinite(q) || q < 30 || q > 100) {
    return { ok: false, error: 'Quality must be between 30 and 100.' };
  }
  const thumbDim = Number(thumbMaxDimension);
  if (!Number.isFinite(thumbDim) || thumbDim < 150 || thumbDim > 1600) {
    return { ok: false, error: 'Thumbnail max dimension must be between 150 and 1600 pixels.' };
  }
  const thumbQ = Number(thumbQuality);
  if (!Number.isFinite(thumbQ) || thumbQ < 30 || thumbQ > 100) {
    return { ok: false, error: 'Thumbnail quality must be between 30 and 100.' };
  }
  if (thumbDim > dim) {
    return { ok: false, error: 'Thumbnail max dimension should not be larger than the full-image max dimension.' };
  }
  return {
    ok: true,
    value: {
      enabled,
      maxDimension:      Math.round(dim),
      quality:           Math.round(q),
      thumbMaxDimension: Math.round(thumbDim),
      thumbQuality:      Math.round(thumbQ),
    },
  };
}

export async function saveImageSettings(settings) {
  await redis.set(REDIS_KEY, settings);
}
