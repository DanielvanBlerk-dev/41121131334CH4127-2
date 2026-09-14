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
const GELATO_QUOTE_API          = 'https://order.gelatoapis.com/v4/orders:quote';
const FROM_POSTCODE      = '4802'; // Airlie Beach, QLD
const QUOTE_TTL_SECONDS  = 900;    // 15 minutes
 
/* ─── AUSPOST (original paintings) ──────────────────────────────────────── */
 
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
 
async function fetchInternationalServices(countryCode, { weight, length, width, height }) {
  const params = new URLSearchParams({
    country_code: countryCode,
    weight:       String(weight),
  });
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
 * Computes combined AusPost postage for the non-Gelato items in the cart.
 * Identical logic to the pre-Gelato version of this file — one call per
 * parcel, intersection of common services, prices summed.
 *
 * Returns { services: [...] } on success, or { message: '...' } if postage
 * could not be quoted for these items (never throws — the caller may still
 * have a working Gelato quote to show alongside this failure).
 */
async function quoteAusPost({ toPostcode, toCountry, items }) {
  if (!items || items.length === 0) return { services: [] };
 
  const isInternational = !!toCountry && toCountry.toUpperCase() !== 'AU';
 
  if (isInternational) {
    if (!/^[A-Z]{2}$/i.test(toCountry)) {
      return { message: 'Invalid destination country code.' };
    }
  } else {
    if (!toPostcode || !/^[0-9]{4}$/.test(String(toPostcode))) {
      return { message: 'Invalid postcode.' };
    }
  }
 
  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    for (const key of ['weight', 'length', 'width', 'height']) {
      const v = parseFloat(p[key]);
      if (isNaN(v) || v <= 0) {
        return { message: `Item ${i + 1}: invalid ${key}.` };
      }
    }
  }
 
  let perParcelResults;
  try {
    perParcelResults = await Promise.all(
      items.map(p =>
        isInternational
          ? fetchInternationalServices(toCountry.toUpperCase(), p)
          : fetchDomesticServices(toPostcode, p)
      )
    );
  } catch (err) {
    console.error('AusPost API error:', err);
    return {
      message: isInternational
        ? 'Could not retrieve international postage rates for this destination. Please contact Michael for a shipping quote.'
        : 'Could not retrieve postage rates from Australia Post. Please contact Michael for a shipping quote.',
    };
  }
 
  const anyEmpty = perParcelResults.some(services => services.length === 0);
  if (anyEmpty) {
    return {
      message: isInternational
        ? 'International postage is not available for one or more items to this destination. Please contact Michael for a shipping quote.'
        : 'Postage rates are not available for one or more items in your cart. Please contact Michael for a shipping quote.',
    };
  }
 
  const firstNames  = new Set(perParcelResults[0].map(s => s.name));
  const commonNames = perParcelResults.slice(1).reduce((names, services) => {
    const available = new Set(services.map(s => s.name));
    return new Set([...names].filter(n => available.has(n)));
  }, firstNames);
 
  if (commonNames.size === 0) {
    return {
      message: isInternational
        ? 'No single postage option covers all items in your cart to this destination. Please contact Michael for a shipping quote.'
        : 'No postage options are available for all items in your cart together. Please contact Michael for a shipping quote.',
    };
  }
 
  const summedServices = [...commonNames].map(name => {
    const total = perParcelResults.reduce((sum, services) => {
      const match = services.find(s => s.name === name);
      return sum + (match ? match.price : 0);
    }, 0);
    return { name, price: Math.round(total * 100) / 100 };
  });
 
  return { services: summedServices };
}
 
/* ─── GELATO (print-on-demand listings) ─────────────────────────────────── */
 
/**
 * Requests a combined shipping quote from Gelato for all Gelato-sourced
 * items in the cart, to a single recipient. Unlike AusPost, Gelato is given
 * every item in ONE call (its `products` array), so the returned price is
 * already the correct combined shipment cost for sending them all together
 * — no manual summing needed on our side.
 *
 * IMPORTANT — response shape caveat:
 * Gelato's published OpenAPI spec documents the request body for
 * /v4/orders:quote precisely, but does not publish a strict schema for the
 * 200 response. The parsing below tries several plausible field names
 * defensively. This should be verified against a real Gelato quote
 * response during testing — if Gelato's actual field names differ, this
 * function will return an empty list rather than throw, which surfaces as
 * "no print shipping options found" rather than a crash.
 *
 * @param {Array<{ productUid: string, quantity?: number }>} gelatoItems
 * @param {object} recipient - { firstName, lastName, addressLine1, addressLine2,
 *                                city, postCode, state, countryCode, email, phone }
 * @returns {Promise<{ services: [{ name, price, shipmentMethodUid, deliveryTime }] } | { message: string }>}
 */
async function quoteGelato(gelatoItems, recipient) {
  if (!gelatoItems || gelatoItems.length === 0) return { services: [] };
 
  const apiKey = process.env.GELATO_API_KEY;
  if (!apiKey) {
    return { message: 'Print shipping is not currently available. Please contact Michael for a quote.' };
  }
 
  if (!recipient || !recipient.countryCode || !/^[A-Z]{2}$/i.test(recipient.countryCode)) {
    return { message: 'A complete shipping address is required to quote print shipping.' };
  }
 
  const requestId = crypto.randomUUID();
  const body = {
    orderReferenceId:    `quote-${requestId}`,
    customerReferenceId: `quote-${requestId}`,
    currency: 'AUD',
    recipient: {
      firstName:    recipient.firstName    || '',
      lastName:     recipient.lastName     || '',
      addressLine1: recipient.addressLine1 || '',
      addressLine2: recipient.addressLine2 || undefined,
      city:         recipient.city         || '',
      postCode:     recipient.postCode     || '',
      state:        recipient.state        || undefined,
      country:      recipient.countryCode.toUpperCase(),
      email:        recipient.email        || undefined,
      phone:        recipient.phone        || undefined,
    },
    products: gelatoItems.map((it, i) => ({
      itemReferenceId: `item-${i}`,
      productUid:      it.productUid,
      quantity:        it.quantity || 1,
    })),
  };
 
  let res;
  try {
    res = await fetch(GELATO_QUOTE_API, {
      method:  'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    console.error('Gelato quote network error:', err);
    return { message: 'Could not reach Gelato for print shipping rates. Please contact Michael for a quote.' };
  }
 
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error('Gelato quote API error:', res.status, errText);
    return { message: 'Could not retrieve print shipping rates for this destination. Please contact Michael for a quote.' };
  }
 
  let data;
  try {
    data = await res.json();
  } catch (err) {
    console.error('Gelato quote response parse error:', err);
    return { message: 'Could not read print shipping rates. Please contact Michael for a quote.' };
  }
 
  // Defensive parsing — see caveat in the function comment above.
  const rawQuotes = data.quotes || data.shipmentMethods || (Array.isArray(data) ? data : []);
  const list = Array.isArray(rawQuotes) ? rawQuotes : [rawQuotes].filter(Boolean);
 
  const services = list.map(q => ({
    name:  q.shipmentMethodName || q.name || 'Print Shipping',
    price: parseFloat(q.price ?? q.shipmentPrice ?? q.totalPrice ?? q.amount) || 0,
    shipmentMethodUid: q.shipmentMethodUid || q.uid || null,
    deliveryTime: (q.minDeliveryDays != null && q.maxDeliveryDays != null)
      ? `${q.minDeliveryDays}–${q.maxDeliveryDays} business days`
      : undefined,
  })).filter(s => s.price > 0);
 
  if (services.length === 0) {
    return { message: 'No print shipping options were found for this destination. Please contact Michael for a quote.' };
  }
 
  return { services };
}
 
/* ─── HANDLER ────────────────────────────────────────────────────────────── */
 
/**
 * POST /api/postage
 *
 * Returns combined postage quotes for a cart that may contain BOTH
 * original paintings (shipped via Australia Post) and Gelato print
 * listings (fulfilled and shipped by Gelato) — as two independent shipping
 * lines, each with its own services list and its own single-use Redis
 * quote per option.
 *
 * Request body:
 *   {
 *     // AusPost — for original/oversized-excluded cart items
 *     toPostcode?: string,       // domestic destination postcode
 *     toCountry?:  string,       // ISO2 code; omit or "AU" for domestic
 *     items?: [{ weight, length, width, height }, ...],
 *
 *     // Gelato — for print-on-demand cart items
 *     gelatoItems?: [{ productUid: string, quantity?: number }],
 *     recipient?: {              // required iff gelatoItems is non-empty
 *       firstName, lastName, addressLine1, addressLine2,
 *       city, postCode, state, countryCode, email, phone
 *     }
 *   }
 *
 * Either side may be entirely absent (a cart of only original paintings
 * sends no gelatoItems; a cart of only prints sends no items/toPostcode).
 * Legacy single-item AusPost shape ({ toPostcode, weight, length, width,
 * height }) is still accepted for backwards compatibility.
 *
 * Response:
 *   {
 *     services?:       [{ name, price, quoteId }],   // AusPost options
 *     message?:        string,                        // AusPost failure, if any
 *     gelatoServices?: [{ name, price, quoteId, deliveryTime }],
 *     gelatoMessage?:  string                          // Gelato failure, if any
 *   }
 * Each side is quoted independently — a failure on one side does not
 * prevent the other from returning usable options.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
 
  const size = checkBodySize(req, '6kb');
  if (!size.ok) return res.status(413).json({ error: size.error });
 
  const csrf = checkCsrf(req);
  if (!csrf.ok) return res.status(403).json({ error: 'Forbidden' });
 
  const {
    toPostcode, toCountry, items,
    weight, length, width, height, // legacy single-item shape
    gelatoItems, recipient,
  } = req.body || {};
 
  // ── Normalise AusPost items array (supports legacy single-item shape) ──
  let ausPostItems = null;
  if (Array.isArray(items) && items.length > 0) {
    ausPostItems = items;
  } else if (weight && length && width && height) {
    ausPostItems = [{ weight, length, width, height }];
  }
 
  const hasGelatoItems = Array.isArray(gelatoItems) && gelatoItems.length > 0;
 
  if (!ausPostItems && !hasGelatoItems) {
    return res.status(400).json({ error: 'No shipping items provided.' });
  }
 
  // ── Run both quote paths in parallel — one failing doesn't block the other ──
  const [ausPostResult, gelatoResult] = await Promise.all([
    ausPostItems ? quoteAusPost({ toPostcode, toCountry, items: ausPostItems }) : Promise.resolve(null),
    hasGelatoItems ? quoteGelato(gelatoItems, recipient) : Promise.resolve(null),
  ]);
 
  const response = {};
 
  // ── Store AusPost quotes ────────────────────────────────────────────────
  if (ausPostResult) {
    if (ausPostResult.message) {
      response.message = ausPostResult.message;
    } else if (ausPostResult.services && ausPostResult.services.length > 0) {
      response.services = await Promise.all(
        ausPostResult.services.map(async service => {
          const quoteId = crypto.randomUUID();
          await redis.set(
            `postage-quote:${quoteId}`,
            JSON.stringify({ name: service.name, price: service.price, source: 'auspost' }),
            { ex: QUOTE_TTL_SECONDS }
          );
          return { name: service.name, price: service.price, quoteId };
        })
      );
    }
  }
 
  // ── Store Gelato quotes ─────────────────────────────────────────────────
  if (gelatoResult) {
    if (gelatoResult.message) {
      response.gelatoMessage = gelatoResult.message;
    } else if (gelatoResult.services && gelatoResult.services.length > 0) {
      response.gelatoServices = await Promise.all(
        gelatoResult.services.map(async service => {
          const quoteId = crypto.randomUUID();
          await redis.set(
            `postage-quote:${quoteId}`,
            JSON.stringify({
              name:  service.name,
              price: service.price,
              source: 'gelato',
              shipmentMethodUid: service.shipmentMethodUid,
            }),
            { ex: QUOTE_TTL_SECONDS }
          );
          return {
            name:  service.name,
            price: service.price,
            quoteId,
            deliveryTime: service.deliveryTime,
          };
        })
      );
    }
  }
 
  return res.status(200).json(response);
}
 

