import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/**
 * The site banner Michael edits from the admin bar: the same dark block the
 * October Night Sea announcement used, between the hero and the gallery on
 * the front page, and under the page heading on the other pages.
 *
 * Stored as one Redis key. Saved through PATCH /api/paintings
 * { action: 'update-banner' } (admin only); read publicly through
 * GET /api/get-artworks, which only includes it when it is switched on.
 *
 *   enabled     — master on/off switch.
 *   headline, body, note, buttonLabel — each optional; a blank one is hidden.
 *   buttonLink  — where the button goes: a site path ("/commissions"),
 *                 a front-page section ("/#gallery") or a full https:// URL.
 *   align       — 'left' | 'center' | 'right' for all banner text.
 *   fonts       — one font key per part (see BANNER_FONTS).
 *   pages       — which pages show it (see BANNER_PAGES).
 *
 * Text is plain text only (no < or >). The browser always inserts it with
 * textContent, never as HTML.
 */

export const BANNER_PAGES = ['home', 'commissions', 'shipping', 'returns', 'privacy'];
export const BANNER_FONTS = ['cormorant', 'dm-mono', 'playfair', 'lora', 'montserrat', 'great-vibes'];
const ALIGNS = ['left', 'center', 'right'];
const PARTS  = ['headline', 'body', 'note', 'button'];

const LIMITS = { headline: 120, body: 600, note: 120, buttonLabel: 40, buttonLink: 300 };

// Matches the October banner: italic Cormorant headline, DM Mono for the rest.
export const DEFAULT_BANNER = {
  enabled: false,
  headline: '', body: '', note: '', buttonLabel: '', buttonLink: '',
  align: 'center',
  fonts: { headline: 'cormorant', body: 'dm-mono', note: 'dm-mono', button: 'dm-mono' },
  pages: ['home'],
};

function cleanText(value, max, label) {
  if (value == null || value === '') return { ok: true, value: '' };
  if (typeof value !== 'string') return { ok: false, error: `${label} must be text.` };
  const text = value.trim();
  if (/[<>]/.test(text)) return { ok: false, error: `${label} cannot contain < or >.` };
  if (text.length > max) return { ok: false, error: `${label} must be ${max} characters or fewer.` };
  return { ok: true, value: text };
}

function isSafeLink(link) {
  // Browsers read a backslash as a slash, so "/\evil.com" would leave the site.
  if (/[\\\s]/.test(link)) return false;
  if (link.startsWith('/')) return !link.startsWith('//') && !/\s/.test(link);
  if (link.startsWith('#')) return !/\s/.test(link);
  try {
    const url = new URL(link);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateBanner(input) {
  const b = input && typeof input === 'object' ? input : {};
  const out = { enabled: b.enabled === true };

  for (const [key, label] of [['headline', 'Headline'], ['body', 'Paragraph'], ['note', 'Note'],
                              ['buttonLabel', 'Button text'], ['buttonLink', 'Button link']]) {
    const r = cleanText(b[key], LIMITS[key], label);
    if (!r.ok) return r;
    out[key] = r.value;
  }

  if (out.buttonLabel && !out.buttonLink) return { ok: false, error: 'Please add where the button links to, or clear the button text.' };
  if (out.buttonLink && !out.buttonLabel) return { ok: false, error: 'Please add the button text, or clear the button link.' };
  if (out.buttonLink && !isSafeLink(out.buttonLink)) {
    return { ok: false, error: 'Button link must start with /, # or https://, with no spaces or backslashes.' };
  }

  out.align = ALIGNS.includes(b.align) ? b.align : 'center';

  const fonts = b.fonts && typeof b.fonts === 'object' ? b.fonts : {};
  out.fonts = {};
  for (const part of PARTS) {
    out.fonts[part] = BANNER_FONTS.includes(fonts[part]) ? fonts[part] : DEFAULT_BANNER.fonts[part];
  }

  if (!Array.isArray(b.pages)) return { ok: false, error: 'Pages must be a list.' };
  out.pages = BANNER_PAGES.filter(p => b.pages.includes(p));

  if (out.enabled && !out.headline && !out.body && !out.note && !out.buttonLabel) {
    return { ok: false, error: 'Add some banner text before switching it on.' };
  }
  if (out.enabled && out.pages.length === 0) {
    return { ok: false, error: 'Tick at least one page to show the banner on.' };
  }

  return { ok: true, value: out };
}

/** Full saved banner (for the admin editor), or the defaults. */
export async function getBanner() {
  try {
    const raw = await redis.get('site-banner');
    const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!saved) return { ...DEFAULT_BANNER };
    const v = validateBanner({ ...saved, enabled: false });
    return v.ok ? { ...v.value, enabled: saved.enabled === true } : { ...DEFAULT_BANNER };
  } catch {
    return { ...DEFAULT_BANNER };
  }
}

export async function saveBanner(banner) {
  await redis.set('site-banner', JSON.stringify(banner));
}

/** What visitors get: null unless switched on. */
export async function getPublicBanner() {
  const b = await getBanner();
  return b.enabled ? b : null;
}
