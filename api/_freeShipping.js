import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/**
 * Site-wide free-shipping offer Michael sets from the admin bar.
 *
 *   enabled    — master switch.
 *   minTotal   — cart total (AUD, artwork prices) that qualifies, or null.
 *   minItems   — number of items in the cart that qualifies, or null.
 *                Either one qualifies the order. Both blank = every order.
 *   scope      — 'au' (Australian addresses only) or 'worldwide'.
 *   startDate, endDate — optional 'YYYY-MM-DD', whole days on Queensland
 *                time (UTC+10, no daylight saving), like listing offers.
 *
 * A qualifying order ships free for every item Michael posts himself
 * (Original / Original Print). Gelato prints and Oversized works are never
 * covered. create-payment.js applies this from Redis, never from the client.
 */

export const DEFAULT_RULE = { enabled: false, minTotal: null, minItems: null, scope: 'au', startDate: '', endDate: '' };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseOptionalNumber(value, { integer, min, max, label }) {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) {
    return { ok: false, error: `${label} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.` };
  }
  return { ok: true, value: n };
}

function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function validateRule(input) {
  const r = input && typeof input === 'object' ? input : {};
  const minTotal = parseOptionalNumber(r.minTotal, { integer: false, min: 1, max: 100000, label: 'Minimum cart total' });
  if (!minTotal.ok) return minTotal;
  const minItems = parseOptionalNumber(r.minItems, { integer: true, min: 1, max: 100, label: 'Minimum number of items' });
  if (!minItems.ok) return minItems;

  const startDate = typeof r.startDate === 'string' ? r.startDate.trim() : '';
  const endDate   = typeof r.endDate   === 'string' ? r.endDate.trim()   : '';
  if (startDate && !validDate(startDate)) return { ok: false, error: 'Start date is not a valid date.' };
  if (endDate   && !validDate(endDate))   return { ok: false, error: 'End date is not a valid date.' };
  if (startDate && endDate && endDate < startDate) return { ok: false, error: 'End date must be on or after the start date.' };

  return {
    ok: true,
    value: {
      enabled:  r.enabled === true,
      minTotal: minTotal.value === null ? null : Math.round(minTotal.value * 100) / 100,
      minItems: minItems.value,
      scope:    r.scope === 'worldwide' ? 'worldwide' : 'au',
      startDate, endDate,
    },
  };
}

/** True while switched on and inside its dates (Queensland time). */
export function ruleIsActive(rule, now = Date.now()) {
  if (!rule || !rule.enabled) return false;
  if (rule.startDate && now < Date.parse(rule.startDate + 'T00:00:00+10:00')) return false;
  if (rule.endDate   && now > Date.parse(rule.endDate + 'T23:59:59.999+10:00')) return false;
  return true;
}

/**
 * Whether an order qualifies. `subtotal` is the artwork total in AUD and
 * `itemCount` the number of cart items, both computed by the server.
 */
export function ruleQualifies(rule, { subtotal, itemCount, countryCode }, now = Date.now()) {
  if (!ruleIsActive(rule, now)) return false;
  if (rule.scope !== 'worldwide' && countryCode !== 'AU') return false;
  const hasTotal = typeof rule.minTotal === 'number';
  const hasItems = typeof rule.minItems === 'number';
  if (!hasTotal && !hasItems) return true;
  return (hasTotal && subtotal >= rule.minTotal) || (hasItems && itemCount >= rule.minItems);
}

export async function getRule() {
  try {
    const raw = await redis.get('free-shipping-rule');
    const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!saved) return { ...DEFAULT_RULE };
    const v = validateRule(saved);
    return v.ok ? v.value : { ...DEFAULT_RULE };
  } catch {
    return { ...DEFAULT_RULE };
  }
}

export async function saveRule(rule) {
  await redis.set('free-shipping-rule', JSON.stringify(rule));
}

/** What visitors get (for the cart message): null unless active right now. */
export async function getPublicRule() {
  const rule = await getRule();
  if (!ruleIsActive(rule)) return null;
  const { minTotal, minItems, scope, startDate, endDate } = rule;
  return { minTotal, minItems, scope, startDate, endDate };
}
