import { Redis } from '@upstash/redis';
import { checkCsrf } from './_csrf.js';
import { checkBodySize } from './_bodyLimit.js';
import { getIp } from './_rateLimit.js';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const AUSPOST_DOMESTIC_API      = 'https://digitalapi.auspost.com.au/postage/parcel/domestic/service.json';
const AUSPOST_INTERNATIONAL_API = 'https://digitalapi.auspost.com.au/postage/parcel/international/service.json';
const FROM_POSTCODE      = '4802'; // Airlie Beach, QLD
const QUOTE_TTL_SECONDS  = 900;    // 15 minutes

/**
 * Calls the AusPost PAC domestic API for a single parcel.
 * Returns an array of { name, price } objects for available services.
 */
async function fetchDomesticServices(toPostcode, { weight, length, width, height }) {
  const params = new URLSearchParams({
    from_postcode: FROM_POSTCODE,
    to_postcode:   toPostcode,
    length:        String(length),
    width:         String(width),
    height:        String(height),
    weight:        String(weight),
  });

  const res = await fetch(`${AUSPOST_DOMESTIC_API}?${params}`, {
    headers: { 'AUTH-KEY': process.env.AUSPOST_API_KEY },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AusPost domestic API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const raw  = data?.services?.service;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];

  return list.map(s => ({
    name:  s.name  || s.type || 'Parcel Post',
    price: parseFloat(s.price) || 0,
  })).filter(s => s.price > 0);
}

/**
 * Calls the AusPost PAC international API for a single parcel.
 *
 * International parcels are quoted by destination country code + weight
 * (dimensions are optional extras — included when available for accuracy,
 * but AusPost's international service only strictly requires weight and
 * country_code).
 *
 * Note: the country code sent here is the ISO 3166-1 alpha-2 code selected
 * in the destination country dropdown. If AusPost doesn't recognise a
 * particular code, the API call fails and the caller falls back to the
 * "contact Michael" message — checkout is never silently broken.
 *
 * @param {string} countryCode  ISO 3166-1 alpha-2 code, e.g. "US", "GB", "NZ"
 * @param {{ weight, length, width, height }} dimensions
 * @returns {Promise<Array<{ name: string, price: number }>>}
 */
async function fetchInternationalServices(countryCode, { weight, length, width, height }) {
  const params = new URLSearchParams({
    country_code: countryCode,
    weight:       String(weight),
  });
  // Dimensions are optional for the international endpoint but improve
  // accuracy when the parcel is large — include them when present.
  if (length) params.set('length', String(length));
  if (width)  params.set('width',  String(width));
  if (height) params.set('height', String(height));

  const res = await fetch(`${AUSPOST_INTERNATIONAL_API}?${params}`, {
    headers: { 'AUTH-KEY': process.env.AUSPOST_API_KEY },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AusPost international API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const raw  = data?.services?.service;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];

  return list.map(s => ({
    name:  s.name  || s.type || 'International Parcel',
    price: parseFloat(s.price) || 0,
  })).filter(s => s.price > 0);
}

/**
 * POST /api/postage
 *
 * Accepts an array of cart items (each with packed shipping dimensions),
 * a destination — either a domestic postcode or an international country
 * code — and returns combined postage quotes across all items.
 *
 * Domestic (Australia):
 *   { toPostcode: "4000", items: [...] }
 *   or toCountry omitted / toCountry === "AU"
 *
 * International:
 *   { toCountry: "US", items: [...] }
 *   toPostcode is not required or used for international quotes —
 *   AusPost's international PAC API quotes by country + weight only.
 *
 * For both paths:
 *   - One AusPost call per cart item, in parallel
 *   - Intersection of service names available for every item
 *   - Prices summed per common service
 *   - Each summed service stored as a single-use Redis quote (15-min TTL)
 *
 * Legacy single-item shape is still accepted for backwards compatibility:
 *   { toPostcode, weight, length, width, height }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const size = checkBodySize(req, '4kb');
  if (!size.ok) return res.status(413).json({ error: size.error });

  const csrf = checkCsrf(req);
  if (!csrf.ok) return res.status(403).json({ error: 'Forbidden' });

  const { toPostcode, toCountry, items, weight, length, width, height } = req.body || {};

  // ── Determine domestic vs international ────────────────────────────────
  // Default to domestic (AU) when toCountry is absent or explicitly "AU".
  const isInternational = !!toCountry && toCountry.toUpperCase() !== 'AU';

  if (isInternational) {
    // ── Validate country code ─────────────────────────────────────────
    if (!/^[A-Z]{2}$/i.test(toCountry)) {
      return res.status(400).json({ error: 'Invalid destination country code.' });
    }
  } else {
    // ── Validate domestic postcode ────────────────────────────────────
    if (!toPostcode || !/^[0-9]{4}$/.test(String(toPostcode))) {
      return res.status(400).json({ error: 'Invalid postcode.' });
    }
  }

  // ── Normalise items array ─────────────────────────────────────────────
  let parcels;
  if (Array.isArray(items) && items.length > 0) {
    parcels = items;
  } else if (weight && length && width && height) {
    parcels = [{ weight, length, width, height }];
  } else {
    return res.status(400).json({ error: 'No shipping dimensions provided.' });
  }

  // ── Validate each parcel's dimensions ────────────────────────────────
  for (let i = 0; i < parcels.length; i++) {
    const p = parcels[i];
    for (const key of ['weight', 'length', 'width', 'height']) {
      const v = parseFloat(p[key]);
      if (isNaN(v) || v <= 0) {
        return res.status(400).json({ error: `Item ${i + 1}: invalid ${key}.` });
      }
    }
  }

  // ── One AusPost call per parcel, in parallel ──────────────────────────
  let perParcelResults;
  try {
    perParcelResults = await Promise.all(
      parcels.map(p =>
        isInternational
          ? fetchInternationalServices(toCountry.toUpperCase(), p)
          : fetchDomesticServices(toPostcode, p)
      )
    );
  } catch (err) {
    console.error('AusPost API error:', err);
    return res.status(200).json({
      message: isInternational
        ? 'Could not retrieve international postage rates for this destination. Please contact Michael for a shipping quote.'
        : 'Could not retrieve postage rates from Australia Post. Please contact Michael for a shipping quote.',
    });
  }

  // ── Filter out any parcel that returned no services ───────────────────
  const anyEmpty = perParcelResults.some(services => services.length === 0);
  if (anyEmpty) {
    return res.status(200).json({
      message: isInternational
        ? 'International postage is not available for one or more items to this destination. Please contact Michael for a shipping quote.'
        : 'Postage rates are not available for one or more items in your cart. Please contact Michael for a shipping quote.',
    });
  }

  // ── Intersection: only keep service names available for every parcel ──
  const firstNames = new Set(perParcelResults[0].map(s => s.name));
  const commonNames = perParcelResults.slice(1).reduce((names, services) => {
    const available = new Set(services.map(s => s.name));
    return new Set([...names].filter(n => available.has(n)));
  }, firstNames);

  if (commonNames.size === 0) {
    return res.status(200).json({
      message: isInternational
        ? 'No single postage option covers all items in your cart to this destination. Please contact Michael for a shipping quote.'
        : 'No postage options are available for all items in your cart together. Please contact Michael for a shipping quote.',
    });
  }

  // ── Sum prices across all parcels for each common service ─────────────
  const summedServices = [...commonNames].map(name => {
    const total = perParcelResults.reduce((sum, services) => {
      const match = services.find(s => s.name === name);
      return sum + (match ? match.price : 0);
    }, 0);
    return { name, price: Math.round(total * 100) / 100 };
  });

  // ── Store each summed service as a single-use Redis quote ─────────────
  const services = await Promise.all(
    summedServices.map(async service => {
      const quoteId = crypto.randomUUID();
      await redis.set(
        `postage-quote:${quoteId}`,
        JSON.stringify({ name: service.name, price: service.price }),
        { ex: QUOTE_TTL_SECONDS }
      );
      return { name: service.name, price: service.price, quoteId };
    })
  );

  return res.status(200).json({ services });
}
