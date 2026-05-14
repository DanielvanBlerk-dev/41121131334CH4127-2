import { Redis } from '@upstash/redis';
import { checkBodySize } from './_bodyLimit.js';
import { checkCsrf } from './_csrf.js';
import { getIp } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ORIGIN_POSTCODE      = '4802';
const AUSPOST_SERVICES_URL = 'https://digitalapi.auspost.com.au/postage/parcel/domestic/service.json';
const QUOTE_TTL_SECS       = 15 * 60; // quotes expire after 15 minutes

/**
 * POST /api/postage
 * Body: { toPostcode, length, width, height, weight }
 *
 * Fetches real postage options from Australia Post, stores each service
 * as a server-side quote in Redis with a 15-minute TTL, and returns
 * the options with quoteIds. create-payment.js looks up the quoteId
 * to get the authoritative price — the client never sets the price.
 *
 * Returns: { services: [ { quoteId, name, price, deliveryTime }, ... ] }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = getIp(req);

  const size = checkBodySize(req, '1kb');
  if (!size.ok) return res.status(413).json({ error: size.error });

  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    await auditLog({ action: 'csrf_rejected', ip, detail: { endpoint: 'postage', reason: csrf.reason } });
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { toPostcode, length, width, height, weight } = req.body || {};

  if (!toPostcode || !/^[0-9]{4}$/.test(String(toPostcode))) {
    return res.status(400).json({ error: 'Please enter a valid 4-digit Australian postcode.' });
  }

  for (const [key, val] of Object.entries({ length, width, height, weight })) {
    if (isNaN(parseFloat(val)) || parseFloat(val) <= 0) {
      return res.status(400).json({ error: `Invalid ${key} value.` });
    }
  }

  const apiKey = process.env.AUSPOST_API_KEY;
  if (!apiKey) {
    console.error('AUSPOST_API_KEY not configured');
    return res.status(500).json({ error: 'Postage service not configured.' });
  }

  const dimParams = new URLSearchParams({
    from_postcode: ORIGIN_POSTCODE,
    to_postcode:   String(toPostcode),
    length:        String(parseFloat(length)),
    width:         String(parseFloat(width)),
    height:        String(parseFloat(height)),
    weight:        String(parseFloat(weight)),
  });

  try {
    // ── Fetch services from Australia Post ────────────────────────────────
    const servicesRes = await fetch(`${AUSPOST_SERVICES_URL}?${dimParams}`, {
      headers: { 'AUTH-KEY': apiKey },
    });

    if (!servicesRes.ok) {
      const text = await servicesRes.text();
      console.error('AusPost services error:', servicesRes.status, text);
      return res.status(502).json({
        error: 'Postage service is temporarily unavailable. Please contact Michael directly for a shipping quote.',
      });
    }

    const servicesData = await servicesRes.json();
    const rawServices  = servicesData.services?.service;
    if (!rawServices) {
      return res.status(200).json({
        services: [],
        message:  'No postage options found for this postcode. Please contact Michael for a quote.',
      });
    }

    const serviceList = Array.isArray(rawServices) ? rawServices : [rawServices];
    const validServices = serviceList.filter(s => s.code && s.price);

    if (validServices.length === 0) {
      return res.status(200).json({
        services: [],
        message:  'No postage options available for this postcode. Please contact Michael for a quote.',
      });
    }

    // ── Store each service as a server-side quote in Redis ────────────────
    // Each quote gets a unique ID. create-payment.js looks up the ID to get
    // the authoritative price — the client cannot alter it.
    const services = await Promise.all(
      validServices.map(async s => {
        const quoteId = crypto.randomUUID();
        const price   = parseFloat(s.price);

        await redis.set(
          `postage-quote:${quoteId}`,
          JSON.stringify({ name: s.name, price }),
          { ex: QUOTE_TTL_SECS }
        );

        return {
          quoteId,
          name:         s.name,
          price,
          deliveryTime: null,
        };
      })
    );

    const sorted = services.sort((a, b) => a.price - b.price);
    return res.status(200).json({ services: sorted });

  } catch (err) {
    console.error('postage error:', err);
    return res.status(500).json({
      error: 'Could not reach the postage service. Please contact Michael directly for a shipping quote.',
    });
  }
}
