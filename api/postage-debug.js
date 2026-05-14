/**
 * GET /api/postage-debug
 * TEMPORARY — delete after diagnosing postage issue.
 * Tests Step 1 of the AusPost PAC API (service list).
 */
export default async function handler(req, res) {
  const apiKey = process.env.AUSPOST_API_KEY;
  if (!apiKey) return res.status(200).json({ error: 'AUSPOST_API_KEY not set' });

  const params = new URLSearchParams({
    from_postcode: '4802',
    to_postcode:   '2000',
    length: '45', width: '35', height: '6', weight: '2',
  });

  try {
    const r    = await fetch(`https://digitalapi.auspost.com.au/postage/parcel/domestic/service.json?${params}`, {
      headers: { 'AUTH-KEY': apiKey },
    });
    const text = await r.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return res.status(200).json({ status: r.status, apiKeyFirst8: apiKey.slice(0,8)+'...', response: parsed });
  } catch (err) {
    return res.status(200).json({ fetchError: err.message });
  }
}
