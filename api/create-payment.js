import { Redis } from '@upstash/redis';
import { getIp, checkRateLimit, recordFailedAttempt, clearAttempts } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';
import { checkCsrf } from './_csrf.js';
import { checkBodySize } from './_bodyLimit.js';
import { capFields } from './_sanitize.js';
import { sendEmail, sendPurchaseNotification } from './_sendEmail.js';
 
const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});
 
const GELATO_ORDERS_API = 'https://order.gelatoapis.com/v4/orders';
 
/* ─── VALIDATORS ──────────────────────────────────────────────────────────── */
function isValidString(str) { return typeof str === 'string' && str.trim().length > 0 && !/[<>]/.test(str); }
function isValidPhone(str)   { return !str || /^[0-9+\s\-]{6,20}$/.test(str); } // phone is optional
function isValidEmail(str)   { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str); }
function hasHtml(str)        { return typeof str === 'string' && /[<>]/.test(str); }
 
/**
 * Validates a postcode/postal code. Domestic (AU) postcodes must be 4
 * digits. International postal codes vary in format — accept a lenient
 * alphanumeric format for any other destination.
 *
 * FIX: the previous version of this validator only accepted numeric
 * postcodes regardless of destination, which silently rejected valid
 * international addresses (e.g. UK "SW1A 1AA") at the final payment step —
 * even after the checkout UI itself was updated to support international
 * shipping. This was the root cause of the original "can't enter my
 * address" support case.
 */
function isValidPostcode(str, countryCode) {
  if (!countryCode || countryCode.toUpperCase() === 'AU') {
    return /^[0-9]{4,10}$/.test(str);
  }
  return /^[A-Za-z0-9\s\-]{2,12}$/.test(str);
}
 
/**
 * Computes the expected total in cents from the live artwork list in Redis,
 * and reports which shipping "sources" are represented in the cart
 * (original paintings shipped via AusPost, and/or Gelato print listings).
 *
 * This is the critical anti-tamper check — we NEVER trust the amount the
 * client sends. We calculate it ourselves from authoritative server data.
 * The sold-check applies to every item regardless of source: for original
 * paintings it means "already purchased"; for Gelato prints it means an
 * admin has manually marked that print offering unavailable. Neither can
 * be bypassed by the client.
 */
async function computeExpectedAmount(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { amountCents: 0, sources: new Set(), artworksById: new Map() };
  }
  const artworks     = (await redis.get('artworks')) || [];
  const artworksById = new Map();
  const sources      = new Set();
  let total = 0;
 
  for (const item of items) {
    const art = artworks.find(a => Number(a.id) === Number(item.id));
    if (!art)       throw new Error(`Artwork ${item.id} not found`);
    if (art.sold)   throw new Error(`Artwork "${art.title}" is already sold`);
    total += art.price;
    sources.add(art.source === 'gelato' ? 'gelato' : 'auspost');
    artworksById.set(Number(art.id), art);
  }
 
  return { amountCents: Math.round(total * 100), sources, artworksById };
}
 
/**
 * Submits a print production order to Gelato after payment has already
 * succeeded. Fire-and-forget from the caller's perspective — a failure
 * here must never affect the customer, who has already been charged
 * correctly. Failures are caught by the caller and logged to the audit
 * trail so Michael can submit the print job manually if needed.
 *
 * CAVEAT — the `files[].type` field below uses 'default' as a reasonable
 * value based on Gelato's general order pattern, but the exact accepted
 * values for this field were not confirmed from published documentation
 * during this integration. This should be verified against a real test
 * order before relying on it for live customer orders. If Gelato rejects
 * it, this function throws and the caller logs it for manual follow-up —
 * it does not silently fail or corrupt any other part of the order.
 *
 * @param {object} opts
 * @param {string} opts.orderId            - our Square payment ID, used as a reference
 * @param {Array}  opts.items              - purchased artwork records with source 'gelato'
 * @param {string} opts.shipmentMethodUid  - captured from the quote the buyer selected
 * @param {object} opts.customer           - { firstName, lastName, email, phone }
 * @param {object} opts.shippingAddress    - { address, city, state, postcode, countryCode }
 */
async function submitGelatoOrder({ orderId, items, shipmentMethodUid, customer, shippingAddress }) {
  const apiKey = process.env.GELATO_API_KEY;
  if (!apiKey) throw new Error('GELATO_API_KEY not configured — cannot submit print order.');
  if (!shipmentMethodUid) throw new Error('No Gelato shipment method captured from quote — cannot submit print order.');
  if (!shippingAddress.countryCode) throw new Error('Missing destination country code — cannot submit print order.');
  // Gelato's shippingAddress schema documents `state` as required (confirmed
  // against dashboard.gelato.com/docs/orders/order_details/, 2026-09) — the
  // checkout form only enforces it client-side for AU addresses, so the
  // handler below now enforces it server-side for every Gelato order before
  // this function is ever called. Checked again here too, defensively.
  if (!shippingAddress.state) throw new Error('Missing state/province — cannot submit print order.');

  const body = {
    orderType:           'order',
    orderReferenceId:    `airliebeachart-${orderId}`,
    customerReferenceId: customer.email,
    currency:            'AUD',
    // `files` IS required per item, even for a product imported from
    // Michael's own Gelato Store — CONFIRMED against a real order attempt
    // (2026-09-16): Gelato rejected the order with
    // "One or more print files are expected for productUid '...'"
    // (items[0].files) when this was omitted. A store product registers the
    // print specs (size/paper/material) but not a fixed design — the actual
    // image to print is still supplied per order, same as Gelato's generic
    // Print API. `art.images[0]` is the artwork's own listing photo — for a
    // fine-art print reproduction that IS the design being printed, so this
    // is the correct file, not a placeholder. If Gelato ever rejects a
    // specific order over file resolution/dimensions instead of a missing
    // file, the failure-alert email below will surface that distinctly.
    items: items.map((art, i) => {
      const fileUrl = art.images && art.images[0];
      if (!fileUrl) throw new Error(`Artwork "${art.title}" (id ${art.id}) has no image to use as a print file.`);
      return {
        itemReferenceId: `item-${i}-${art.id}`,
        productUid:      art.gelatoProductUid,
        files: [
          { type: 'default', url: fileUrl },
        ],
        quantity: 1,
      };
    }),
    shipmentMethodUid,
    shippingAddress: {
      firstName:    customer.firstName,
      lastName:     customer.lastName,
      addressLine1: shippingAddress.address,
      city:         shippingAddress.city,
      postCode:     shippingAddress.postcode,
      state:        shippingAddress.state,
      country:      shippingAddress.countryCode.toUpperCase(),
      email:        customer.email,
      phone:        customer.phone || undefined,
    },
  };
 
  const res = await fetch(GELATO_ORDERS_API, {
    method:  'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
 
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gelato order API error ${res.status}: ${errText}`);
  }

  return res.json();
}

/**
 * Emails Michael immediately when a Gelato print-order submission fails
 * after the buyer has already been charged. Previously this was logged only
 * to console.error and an internal audit-log entry — both invisible unless
 * someone went looking for them (Vercel's log retention is an hour on the
 * current plan, and there's no admin UI for the audit log). This is the
 * only alerting for that failure path, so — unlike the purchase
 * notification — it deliberately does NOT depend on that Gelato call having
 * succeeded, and a failure to send it must never throw back into the
 * caller's already-settled payment flow.
 */
async function sendGelatoFailureAlert({ orderId, items, customer, shippingAddress, error }) {
  const adminEmail = process.env.ADMIN_EMAIL || 'michael.p.vanblerk@gmail.com';
  const itemLines = items.map(a => `<li>${a.title} (id ${a.id}, product UID: ${a.gelatoProductUid || '—'})</li>`).join('');

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9f6f1;font-family:'Courier New',monospace;font-size:13px;color:#1a1612;">
  <div style="max-width:580px;margin:40px auto;background:#fff;border:1px solid rgba(26,22,18,0.12);">
    <div style="background:#5a1a1a;padding:24px 32px;">
      <p style="margin:0;font-family:Georgia,serif;font-size:22px;font-weight:300;color:#f9f6f1;letter-spacing:0.1em;text-transform:uppercase;">
        Airlie Beach Art
      </p>
      <p style="margin:6px 0 0;font-size:11px;color:#e0a0a0;letter-spacing:0.15em;text-transform:uppercase;">
        Gelato print order FAILED — Order ${orderId}
      </p>
    </div>
    <div style="padding:32px;">
      <div style="background:#fbeaea;border:1px solid #e0a0a0;padding:12px 16px;margin-bottom:24px;">
        <p style="margin:0;font-size:12px;color:#5a1a1a;">
          The customer was charged successfully, but the print job could NOT be submitted to Gelato.
          You will need to place this print order manually.
        </p>
      </div>
      <p style="margin:0 0 8px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#b8965a;">Error</p>
      <div style="padding:12px;background:#f9f6f1;border:1px solid #ede9e1;margin-bottom:24px;white-space:pre-wrap;word-break:break-word;">${error}</div>
      <p style="margin:0 0 8px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#b8965a;">Print items</p>
      <ul style="margin:0 0 24px;padding-left:20px;">${itemLines}</ul>
      <p style="margin:0 0 8px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#b8965a;">Customer</p>
      <p style="margin:0 0 24px;">
        ${customer.firstName} ${customer.lastName} — <a href="mailto:${customer.email}">${customer.email}</a>${customer.phone ? ' — ' + customer.phone : ''}<br>
        ${shippingAddress.address}, ${shippingAddress.city} ${shippingAddress.state} ${shippingAddress.postcode}, ${shippingAddress.countryCode}
      </p>
      <p style="margin:0;font-size:11px;color:#7a7368;line-height:1.7;">
        Order ID ${orderId} — payment already confirmed by Square.
      </p>
    </div>
  </div>
</body>
</html>`;

  return sendEmail({
    to:      adminEmail,
    subject: `⚠ Gelato order FAILED — ${orderId}`,
    html,
  });
}
 
/**
 * POST /api/create-payment
 *
 * Security properties:
 * - Rate-limited: 3 payment attempts per IP per 10 minutes
 * - Amount is computed server-side from Redis — client-sent amount is ignored
 * - Sold artworks are rejected before charging (applies to Gelato prints too —
 *   an admin can mark a print offering unavailable the same way)
 * - sourceId (Square token) is single-use; we never store it
 * - No card data ever passes through this function
 * - Idempotency key is generated fresh per request (UUID)
 * - Postage: accepts one or two single-use quote IDs (postageQuoteIds) — one
 *   per shipping "domain" present in the cart (AusPost for original
 *   paintings, Gelato for print listings). Each quote's price is looked up
 *   server-side from Redis, never trusted from the client. A quote whose
 *   source doesn't match a domain actually present in the cart is ignored,
 *   and a domain that IS present but has no matching quote blocks payment —
 *   this prevents a buyer paying only AusPost postage while a print item
 *   silently rides along for free, or vice versa.
 * - Audit logged (IP, items, order ID — never card data)
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const ip = getIp(req);
 
  // ── Body size limit ───────────────────────────────────────────────────
  const size = checkBodySize(req, '10kb');
  if (!size.ok) return res.status(413).json({ success: false, error: size.error });
 
  // ── CSRF check ────────────────────────────────────────────────────────
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    await auditLog({ action: 'csrf_rejected', ip, detail: { endpoint: 'create-payment', reason: csrf.reason } });
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
 
  // ── Rate limit: max 3 payment attempts per IP per 10 min ──────────────
  const { limited, retryAfterSecs } = await checkRateLimit(ip, 'payment');
  if (limited) {
    const mins = Math.ceil(retryAfterSecs / 60);
    await auditLog({ action: 'payment_rate_limited', ip });
    return res.status(429).json({
      success: false,
      error: `Too many payment attempts. Please wait ${mins} minute${mins !== 1 ? 's' : ''} before trying again.`,
    });
  }
 
  // ── Input validation ──────────────────────────────────────────────────
  const {
    sourceId, currency = 'AUD',
    email, firstName, lastName,
    address, city, state = '', postcode, phone,
    country = 'Australia', countryCode = null, // countryCode: ISO2, new — needed for Gelato
    items = [],
    postageQuoteId,   // legacy — single quote ID, kept for backwards compatibility
    postageQuoteIds,  // current — array of 1–2 quote IDs (AusPost and/or Gelato)
  } = req.body || {};
 
  // Normalise the country code the client selected in its country dropdown.
  // Only strictly required when the cart contains Gelato print items —
  // checked further down once we know what's actually in the cart.
  const normalisedCountryCode = (typeof countryCode === 'string' && /^[A-Z]{2}$/i.test(countryCode))
    ? countryCode.toUpperCase()
    : null;
 
  if (
    !isValidString(sourceId)   ||
    !isValidString(firstName)  ||
    !isValidString(lastName)   ||
    !isValidString(address)    ||
    !isValidString(city)       ||
    !isValidPostcode(postcode, normalisedCountryCode) ||
    !isValidPhone(phone)       ||
    !isValidEmail(email)       ||
    hasHtml(country)           ||
    hasHtml(state)             ||
    !Array.isArray(items)      ||
    items.length === 0
  ) {
    return res.status(400).json({ success: false, error: 'Invalid or incomplete form data' });
  }
 
  // ── Compute amount + cart composition server-side — never trust the client ──
  let expectedArtworkCents, cartSources, artworksById;
  try {
    const result = await computeExpectedAmount(items);
    expectedArtworkCents = result.amountCents;
    cartSources          = result.sources;      // Set containing 'auspost' and/or 'gelato'
    artworksById         = result.artworksById;
  } catch (err) {
    await auditLog({ action: 'payment_rejected', ip, detail: { reason: err.message } });
    return res.status(400).json({ success: false, error: err.message });
  }
 
  // Gelato print items require a valid destination country code to fulfil.
  if (cartSources.has('gelato') && !normalisedCountryCode) {
    return res.status(400).json({ success: false, error: 'A valid destination country is required for print orders.' });
  }

  // Gelato's shippingAddress schema also requires `state` — the checkout
  // form's own JS (script.js validateForm) only makes the buyer fill it in
  // for Australian addresses, so a non-AU Gelato order could otherwise reach
  // here with an empty state and get silently dropped from the Gelato
  // request later (JSON.stringify drops `undefined` values). Enforce it
  // server-side for every Gelato order, regardless of destination country.
  if (cartSources.has('gelato') && !isValidString(state)) {
    return res.status(400).json({ success: false, error: 'A state/province is required for print orders.' });
  }
 
  // ── Validate + resolve postage quote(s) ────────────────────────────────
  // Accept either the current array shape or the legacy single-ID shape.
  let quoteIdList;
  if (Array.isArray(postageQuoteIds) && postageQuoteIds.length > 0) {
    quoteIdList = postageQuoteIds;
  } else if (postageQuoteId) {
    quoteIdList = [postageQuoteId];
  } else {
    quoteIdList = [];
  }
 
  if (
    quoteIdList.length === 0 ||
    quoteIdList.length > 2 ||
    !quoteIdList.every(id => typeof id === 'string' && id.length > 0 && id.length <= 64)
  ) {
    return res.status(400).json({ success: false, error: 'Invalid postage selection. Please recalculate postage and try again.' });
  }
 
  // Fetch and delete each quote sequentially (single-use, prevents replay).
  const resolvedQuotes = []; // [{ name, price, source, shipmentMethodUid? }]
  for (const quoteId of quoteIdList) {
    const quoteKey = `postage-quote:${quoteId}`;
    const quoteRaw = await redis.get(quoteKey);
    if (!quoteRaw) {
      return res.status(400).json({ success: false, error: 'Postage quote has expired. Please recalculate postage and try again.' });
    }
    let quote;
    try {
      quote = typeof quoteRaw === 'string' ? JSON.parse(quoteRaw) : quoteRaw;
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid postage quote. Please recalculate postage and try again.' });
    }
    await redis.del(quoteKey); // single use — delete immediately regardless of outcome below
 
    const price = parseFloat(quote.price);
    if (isNaN(price) || price < 0 || price > 500) {
      return res.status(400).json({ success: false, error: 'Invalid postage amount in quote.' });
    }
    resolvedQuotes.push({
      name:  quote.name,
      price,
      source: quote.source === 'gelato' ? 'gelato' : 'auspost',
      shipmentMethodUid: quote.shipmentMethodUid || null,
    });
  }
 
  // Only count a quote toward the total if its source is actually present
  // in the cart — a stray or mismatched quote from a stale client can never
  // add an unrelated charge or silently substitute for a missing one.
  const usableQuotes = resolvedQuotes.filter(q => cartSources.has(q.source));
 
  if (cartSources.has('auspost') && !usableQuotes.some(q => q.source === 'auspost')) {
    return res.status(400).json({ success: false, error: 'Please select a postage option before completing your purchase.' });
  }
  if (cartSources.has('gelato') && !usableQuotes.some(q => q.source === 'gelato')) {
    return res.status(400).json({ success: false, error: 'Please select a print shipping option before completing your purchase.' });
  }
 
  const postageAmount = usableQuotes.reduce((sum, q) => sum + q.price, 0);
  const postageName   = usableQuotes.map(q => q.name).join(' + ') || 'Postage';
  const gelatoQuote    = usableQuotes.find(q => q.source === 'gelato') || null;
 
  // ── Length caps ───────────────────────────────────────────────────────
  const caps = capFields([
    ['First name', firstName, 100],
    ['Last name',  lastName,  100],
    ['Email',      email,     254],
    ['Address',    address,   300],
    ['City',       city,      100],
    ['State',      state || '', 100],
    ['Country',    country,   100],
    ['Postcode',   postcode,   12],
    ['Phone',      phone || '', 20],
  ]);
  if (!caps.ok) return res.status(400).json({ success: false, error: caps.error });
 
  // ── Reject clearly invalid sourceId format ────────────────────────────
  if (sourceId.length < 10 || sourceId.length > 512) {
    return res.status(400).json({ success: false, error: 'Invalid payment token' });
  }
 
  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId  = process.env.SQUARE_LOCATION_ID;
 
  if (!accessToken || !locationId) {
    console.error('Square credentials not configured');
    return res.status(500).json({ success: false, error: 'Payment service misconfigured' });
  }
 
  // ── Final total: artwork prices (already validated) + postage ─────────
  const postageCents        = Math.round(postageAmount * 100);
  const expectedAmountCents = expectedArtworkCents + postageCents;
 
  if (expectedAmountCents <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid order total' });
  }
 
  // ── Charge via Square ─────────────────────────────────────────────────
  try {
    const squareRes = await fetch('https://connect.squareup.com/v2/payments', {
      method: 'POST',
      headers: {
        'Square-Version': '2024-10-17',
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        source_id:           sourceId,
        idempotency_key:     crypto.randomUUID(),
        amount_money:        { amount: expectedAmountCents, currency },
        location_id:         locationId,
        buyer_email_address: email,
      }),
    });
 
    const data = await squareRes.json();
 
    if (!squareRes.ok) {
      await recordFailedAttempt(ip, 'payment');
      console.error('Square payment error:', JSON.stringify(data));
      await auditLog({
        action: 'payment_failed',
        ip,
        detail: {
          squareCode:     data.errors?.[0]?.code,
          squareCategory: data.errors?.[0]?.category,
          itemCount:      items.length,
          amountCents:    expectedAmountCents,
        },
      });
      return res.status(502).json({ success: false, error: 'Payment could not be processed. Please check your card details and try again.' });
    }
 
    // ── Payment succeeded ───────────────────────────────────────────────
    const orderId = data.payment.id;
    await clearAttempts(ip, 'payment');
 
    // Re-fetch the live artwork list to apply the sold-state update.
    // IMPORTANT: original paintings are marked sold (one-of-a-kind).
    // Gelato print listings are NEVER auto-marked sold by a purchase —
    // they remain available for other buyers, since a print is not unique.
    // "sold" on a Gelato listing stays a manual admin action only (e.g.
    // discontinuing that print offering).
    const purchasedIds  = new Set(items.map(i => Number(i.id)));
    let artworks         = (await redis.get('artworks')) || [];
    const purchasedItems = artworks.filter(a => purchasedIds.has(Number(a.id)));
    artworks = artworks.map(a =>
      purchasedIds.has(Number(a.id)) && a.source !== 'gelato'
        ? { ...a, sold: true }
        : a
    );
    await redis.set('artworks', artworks);
 
    await auditLog({
      action: 'payment_success',
      ip,
      detail: {
        orderId,
        itemCount:    items.length,
        amountCents:  expectedAmountCents,
        postageName,
        postageCents,
        hasGelatoItems: cartSources.has('gelato'),
      },
    });
 
    // ── Store full order record in Redis ──────────────────────────────────
    // Retained for 90 days. Accessible via GET /api/get-orders (admin only).
    const orderRecord = {
      orderId,
      ts:           new Date().toISOString(),
      grandTotal:   expectedAmountCents / 100,
      artworkTotal: expectedArtworkCents / 100,
      postageName,
      postagePrice: postageAmount,
      // Per-line shipping breakdown, kept alongside the combined fields
      // above for any future admin UI that wants to show them separately.
      postageLines: usableQuotes.map(q => ({ name: q.name, price: q.price, source: q.source })),
      items: purchasedItems.map(a => ({
        id:     a.id,
        title:  a.title,
        price:  a.price,
        source: a.source === 'gelato' ? 'gelato' : 'original',
        variantLabel: a.variantLabel || null,
      })),
      customer: { firstName, lastName, email, phone: phone || '' },
      shipping: { address, city, state, postcode, country },
    };
 
    await redis.set(`order:${orderId}`, JSON.stringify(orderRecord), { ex: 90 * 24 * 60 * 60 });
    await redis.lpush('order-index', orderId);
    await redis.ltrim('order-index', 0, 499);
 
    // ── Send purchase notification to admin ───────────────────────────────
    // AWAITED, not fire-and-forget. It was fire-and-forget originally (to
    // never let a slow email API delay the buyer's checkout response), but
    // on Vercel that's a real trap: once the HTTP response is sent, the
    // function's execution can be frozen/torn down immediately, and a
    // promise nobody waited on can simply never finish — which is exactly
    // what was happening here (confirmed: real orders completed, nothing
    // ever reached Resend at all). Wrapped in try/catch so a failure here
    // still can never fail or block the buyer's payment — it just means the
    // response takes an extra beat while this completes first.
    try {
      await sendPurchaseNotification({
        orderId,
        items:        purchasedItems.map(a => ({ title: a.title, price: a.price })),
        artworkTotal: expectedArtworkCents / 100,
        postageName,
        postagePrice: postageAmount,
        grandTotal:   expectedAmountCents / 100,
        customer:     { firstName, lastName, email, phone: phone || '' },
        shipping:     { address, city, state, postcode, country },
      });
    } catch (err) {
      console.error('Purchase notification email failed:', err);
    }

    // ── Submit print job(s) to Gelato ──────────────────────────────────────
    // Also now awaited, for the same reason as above — the customer has
    // already been charged correctly either way, and a failure here still
    // can never affect the checkout response the buyer sees, it just means
    // this is resolved (successfully or not, including the failure-alert
    // email) before that response is sent, instead of racing the function
    // being torn down.
    const gelatoPurchasedItems = purchasedItems.filter(a => a.source === 'gelato');
    if (gelatoPurchasedItems.length > 0) {
      try {
        await submitGelatoOrder({
          orderId,
          items: gelatoPurchasedItems,
          shipmentMethodUid: gelatoQuote?.shipmentMethodUid || null,
          customer: { firstName, lastName, email, phone: phone || '' },
          shippingAddress: { address, city, state, postcode, countryCode: normalisedCountryCode },
        });
      } catch (err) {
        console.error('Gelato order submission failed:', err);
        try {
          await auditLog({
            action: 'gelato_order_failed',
            ip,
            detail: {
              orderId,
              error:   err.message,
              itemIds: gelatoPurchasedItems.map(a => a.id),
            },
          });
        } catch {}
        try {
          await sendGelatoFailureAlert({
            orderId,
            items: gelatoPurchasedItems,
            customer: { firstName, lastName, email, phone: phone || '' },
            shippingAddress: { address, city, state, postcode, countryCode: normalisedCountryCode },
            error: err.message,
          });
        } catch (emailErr) {
          console.error('Gelato failure alert email also failed:', emailErr);
        }
      }
    }

    return res.status(200).json({ success: true, orderId });
 
  } catch (err) {
    console.error('create-payment unexpected error:', err);
    await auditLog({ action: 'payment_error', ip, detail: { error: err.message } });
    return res.status(500).json({ success: false, error: 'An unexpected error occurred. Please try again.' });
  }
}
 

