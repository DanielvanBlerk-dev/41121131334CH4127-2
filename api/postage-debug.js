import { checkBodySize } from './_bodyLimit.js';

const ORIGIN_POSTCODE = '4802';

/**
 * GET /api/postage-debug
 * TEMPORARY — delete after diagnosing postage issue.
 * Tests the Australia Post API connection and returns the raw response.
 */
export default async function handler(req, res) {
  const apiKey = process.env.AUSPOST_API_KEY;

  if (!apiKey) {
    return res.status(200).json({ error: 'AUSPOST_API_KEY not set in Vercel env vars' });
  }

  const params = new URLSearchParams({
    from_postcode: ORIGIN_POSTCODE,
    to_postcode:   '2000',
    length:        '45',
    width:         '35',
    height:        '6',
    weight:        '2',
  });

  try {
    const auspostRes = await fetch(
      `https://digitalapi.auspost.com.au/postage/parcel/domestic/calculate.json?${params}`,
      {
        method:  'GET',
        headers: {
          'AUTH-KEY':     apiKey,
          'Content-Type': 'application/json',
        },
      }
    );

    const text = await auspostRes.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }

    return res.status(200).json({
      status:      auspostRes.status,
      statusText:  auspostRes.statusText,
      apiKeyFirst8: apiKey.slice(0, 8) + '...',
      response:    parsed,
    });
  } catch (err) {
    return res.status(200).json({ fetchError: err.message });
  }
}
