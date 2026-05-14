/**
 * sanitizeString — strips XSS vectors from a string before storage.
 */
export function sanitizeString(str) {
  if (!str || typeof str !== 'string') return '';

  // Remove script/iframe tags entirely
  str = str.replace(/<\s*script.*?>.*?<\s*\/\s*script>/gi, '');
  str = str.replace(/<\s*iframe.*?>.*?<\s*\/\s*iframe>/gi, '');

  // Remove on* event attributes (onload, onclick, etc.)
  str = str.replace(/on\w+="[^"]*"/gi, '');
  str = str.replace(/on\w+='[^']*'/gi, '');

  // Escape & < > " — & must come first to avoid double-escaping
  str = str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return str.trim();
}

/**
 * capLength — trims a string to a maximum character length.
 * Returns { ok: false, error } if the value exceeds the cap.
 * Returns { ok: true, value } with the original value if within limit.
 *
 * Why check rather than silently truncate?
 * Silent truncation could corrupt data (e.g. a title cut mid-word)
 * and would hide attempts to send oversized payloads. Rejecting
 * with a clear error message is safer and easier to debug.
 *
 * Usage:
 *   const check = capLength('title', title, 200);
 *   if (!check.ok) return res.status(400).json({ error: check.error });
 */
export function capLength(fieldName, value, max) {
  if (typeof value !== 'string') {
    return { ok: false, error: `${fieldName} must be a string.` };
  }
  if (value.length > max) {
    return {
      ok:    false,
      error: `${fieldName} must be ${max} characters or fewer (received ${value.length}).`,
    };
  }
  return { ok: true, value };
}

/**
 * capFields — validates multiple fields in one call.
 * Pass an array of [fieldName, value, maxLength] tuples.
 * Returns { ok: false, error } on the first failure,
 * or { ok: true } if all pass.
 *
 * Usage:
 *   const caps = capFields([
 *     ['title',  title,  200],
 *     ['medium', medium, 300],
 *   ]);
 *   if (!caps.ok) return res.status(400).json({ error: caps.error });
 */
export function capFields(fields) {
  for (const [name, value, max] of fields) {
    const result = capLength(name, value, max);
    if (!result.ok) return result;
  }
  return { ok: true };
}
