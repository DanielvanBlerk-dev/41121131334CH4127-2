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
 *   enabled       — master on/off switch. When false, uploads are stored
 *                    exactly as received (the pre-existing behaviour,
 *                    before this feature existed).
 *   maxDimension  — longest edge, in pixels, an uploaded image is resized
 *                    down to. An image already smaller than this is left
 *                    at its original resolution — only re-compressed,
 *                    never upscaled.
 *   quality       — JPEG/WEBP re-encode quality, 1-100. Only applies to
 *                    the formats that actually get re-encoded — see
 *                    _imageCompress.js for exactly which that is and why
 *                    (a transparent PNG and an animated GIF are handled
 *                    differently).
 *
 * This module is underscore-prefixed like the project's other shared
 * helpers (_verifyAdmin.js, _sanitize.js, etc.) — Vercel does not deploy
 * these as their own routes, so adding it costs nothing against the
 * Hobby plan's 12-function limit.
 */
const REDIS_KEY = 'image-settings';

export const DEFAULT_IMAGE_SETTINGS = Object.freeze({
  enabled:      true,
  maxDimension: 2400,
  quality:      82,
});

/**
 * Reads the current settings from Redis, filling in any missing field
 * with its default — so a brand-new deployment (nothing saved yet) or a
 * partially-saved record never breaks an upload.
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
    enabled:      typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULT_IMAGE_SETTINGS.enabled,
    maxDimension: Number.isFinite(stored.maxDimension) ? stored.maxDimension : DEFAULT_IMAGE_SETTINGS.maxDimension,
    quality:      Number.isFinite(stored.quality) ? stored.quality : DEFAULT_IMAGE_SETTINGS.quality,
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
  const { enabled, maxDimension, quality } = input || {};
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
  return { ok: true, value: { enabled, maxDimension: Math.round(dim), quality: Math.round(q) } };
}

export async function saveImageSettings(settings) {
  await redis.set(REDIS_KEY, settings);
}
