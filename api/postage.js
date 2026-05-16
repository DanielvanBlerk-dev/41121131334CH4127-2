import { Redis } from '@upstash/redis';
import { checkCsrf } from './_csrf.js';
import { checkBodySize } from './_bodyLimit.js';
import { getIp } from './_rateLimit.js';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const AUSPOST_API  = 'https://digitalapi.auspost.com.au/postage/parcel/domestic/service.json';
const FROM_POSTCODE = '4802'; // Airlie Beach, QLD
const QUOTE_TTL_SECONDS = 900; // 15 minutes

/**
 * Calls the AusPost PAC API for a single parcel.
 * Returns an array of { name, price } objects for available services,
 * or throws on network/API failure.
 *
 * @param {string} toPostcode
 * @param {{ weight, length, width, height }} dimensions  packed dimensions
 * @returns {Promise<Array<{ name: string, price: number }>>}
 */
async function fetchAusPostServices(toPostcode, { weight, length, width, height }) {
  const params = new URLSearchParams({
    from_postcode: FROM_POSTCODE,
    to_postcode:   toPostcode,
    length:        String(length),
    width:         String(width),
    height:        String(height),
    weight:        String(weight),
  });

  const res = await fetch(`${AUSPOST_API}?${params}`, {
    headers: { 'AUTH-KEY': process.env.AUSPOST_API_KEY },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AusPost API error ${res.status}: ${body}`);
  }

  const data = await res.json();

  // AusPost returns { services: { service: [...] } } or { services: { service: {...} } }
  // for a single result. Normalise to an array.
  const raw = data?.services?.service;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];

  return list.map(s => ({
    name:  s.name  || s.type || 'Parcel Post',
    price: parseFloat(s.price) || 0,
  })).filter(s => s.price > 0);
}

/**
 * POST /api/postage
 *
 * Accepts an array of cart items (each with packed shipping dimensions)
 * and a destination postcode. Makes one AusPost PAC call per item in
 * parallel, then:
 *   - Takes the intersection of service names available across all items
 *     (a service only appears if AusPost offers it for every parcel)
 *   - Sums the price for each common service across all items
 *   - Stores each summed service as a Redis quote (15-min TTL, single-use UUID)
 *   - Returns the services + quoteIds to the browser
 *
 * Request body:
 *   {
 *     toPostcode: string,
 *     items: [
 *       { weight: number, length: number, width: number, height: number },
 *       ...
 *     ]
 *   }
 *
 * Response (success):
 *   { services: [{ name, price, quoteId }] }
 *
 * Response (error):
 *   { error: string } or { message: string }
 *
 * Legacy single-item shape is still accepted for backwards compatibility:
 *   { toPostcode, weight, length, width, height }
 * This is normalised to items: [{ weight, length, width, height }] internally.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const size = checkBodySize(req, '4kb');
  if (!size.ok) return res.status(413).json({ error: size.error });

  const csrf = checkCsrf(req);
  if (!csrf.ok) return res.status(403).json({ error: 'Forbidden' });

  const { toPostcode, items, weight, length, width, height } = req.body || {};

  // ── Validate destination postcode ─────────────────────────────────────
  if (!toPostcode || !/^[0-9]{4}$/.test(String(toPostcode))) {
    return res.status(400).json({ error: 'Invalid postcode.' });
  }

  // ── Normalise items array ─────────────────────────────────────────────
  // Accept both new multi-item shape { items: [...] } and legacy single-item
  // shape { weight, length, width, height } from older clients.
  let parcels;
  if (Array.isArray(items) && items.length > 0) {
    parcels = items;
  } else if (weight && length && width && height) {
    // Legacy single-item shape — wrap in array
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
      parcels.map(p => fetchAusPostServices(toPostcode, p))
    );
  } catch (err) {
    console.error('AusPost API error:', err);
    return res.status(200).json({
      message: 'Could not retrieve postage rates from Australia Post. Please contact Michael for a shipping quote.',
    });
  }

  // ── Filter out any parcel that returned no services ───────────────────
  // If any parcel has no rates, we cannot quote reliably for the whole order.
  const anyEmpty = perParcelResults.some(services => services.length === 0);
  if (anyEmpty) {
    return res.status(200).json({
      message: 'Postage rates are not available for one or more items in your cart. Please contact Michael for a shipping quote.',
    });
  }

  // ── Intersection: only keep service names available for every parcel ──
  // Start with the service names from the first parcel, then filter down
  // to only those that appear in every subsequent parcel's result.
  const firstNames = new Set(perParcelResults[0].map(s => s.name));
  const commonNames = perParcelResults.slice(1).reduce((names, services) => {
    const available = new Set(services.map(s => s.name));
    return new Set([...names].filter(n => available.has(n)));
  }, firstNames);

  if (commonNames.size === 0) {
    return res.status(200).json({
      message: 'No postage options are available for all items in your cart together. Please contact Michael for a shipping quote.',
    });
  }

  // ── Sum prices across all parcels for each common service ─────────────
  const summedServices = [...commonNames].map(name => {
    const total = perParcelResults.reduce((sum, services) => {
      const match = services.find(s => s.name === name);
      return sum + (match ? match.price : 0);
    }, 0);
    return { name, price: Math.round(total * 100) / 100 }; // round to cents
  });

  // ── Store each summed service as a single-use Redis quote ─────────────
  // The client receives the quoteId and sends it back at payment time.
  // The server looks up the authoritative price from Redis — the client
  // never sends a price directly, so postage manipulation is impossible.
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
