/**
 * _csrf.js — CSRF protection for all mutating API routes
 *
 * Strategy: double defence
 *
 * 1. Custom header check (X-Requested-With: XMLHttpRequest)
 *    Browsers enforce the Same-Origin Policy on custom headers —
 *    a cross-origin form or fetch cannot set this header without
 *    a CORS preflight, which our server does not permit.
 *
 * 2. Origin / Referer validation
 *    Verifies the request originated from our own domain.
 *    Falls back to Referer if Origin is absent (some browsers
 *    omit Origin on same-origin requests).
 *
 * Both checks must pass. Either one failing rejects the request.
 *
 * Note: GET requests are never mutating and don't need CSRF protection.
 * Apply this only to POST / PUT / PATCH / DELETE handlers.
 */

const ALLOWED_ORIGINS = (() => {
  const origins = [];

  // Production domain — set ALLOWED_ORIGIN in Vercel env vars
  // e.g. https://your-site.vercel.app  or  https://yourdomain.com
  if (process.env.ALLOWED_ORIGIN) {
    origins.push(process.env.ALLOWED_ORIGIN.replace(/\/$/, ''));
  }

  // Always allow Vercel preview deployments for your project
  if (process.env.VERCEL_URL) {
    origins.push(`https://${process.env.VERCEL_URL}`);
  }

  return origins;
})();

/**
 * Checks the request for valid CSRF indicators.
 * Returns { ok: true } on success.
 * Returns { ok: false, reason: string } on failure.
 */
export function checkCsrf(req) {
  // 1. Custom header — must be present
  const customHeader = req.headers['x-requested-with'];
  if (!customHeader || customHeader !== 'XMLHttpRequest') {
    return { ok: false, reason: 'Missing or invalid X-Requested-With header' };
  }

  // 2. Origin / Referer check
  const origin  = req.headers['origin']  || '';
  const referer = req.headers['referer'] || '';

  // Use Origin first — it's more reliable
  if (origin) {
    const normalised = origin.replace(/\/$/, '');
    if (!ALLOWED_ORIGINS.includes(normalised)) {
      return { ok: false, reason: `Origin not allowed: ${origin}` };
    }
    return { ok: true };
  }

  // Fall back to Referer
  if (referer) {
    const allowed = ALLOWED_ORIGINS.some(o => referer.startsWith(o));
    if (!allowed) {
      return { ok: false, reason: `Referer not allowed: ${referer}` };
    }
    return { ok: true };
  }

  // Neither Origin nor Referer present — reject
  // (legitimate same-origin browser requests always send at least one)
  return { ok: false, reason: 'No Origin or Referer header present' };
}
