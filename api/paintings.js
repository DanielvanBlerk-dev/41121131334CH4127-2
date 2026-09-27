import { Redis } from '@upstash/redis';
import { del, put } from '@vercel/blob';
import { verifyAdmin } from './_verifyAdmin.js';
import { sanitizeString, capFields } from './_sanitize.js';
import { getIp } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';
import { checkCsrf } from './_csrf.js';
import { checkBodySize } from './_bodyLimit.js';
import { getImageSettings, saveImageSettings, validateImageSettings } from './_imageSettings.js';
import { compressImage, compressToVariants } from './_imageCompress.js';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const GELATO_ECOMMERCE_API = 'https://ecommerce.gelatoapis.com';

function isValidString(str) {
  return typeof str === 'string' && str.trim().length > 0 && !/[<>]/.test(str);
}

/**
 * Validates and cleans a `collections` field — a free-text array of
 * collection names a painting belongs to (Task 4: admin organisation +
 * a public filter bar, see script.js/style.css). Absent/undefined is
 * treated as "no collections" rather than an error, so existing records
 * and callers that don't send this field remain valid.
 */
function validateCollections(input) {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'Collections must be an array of names.' };
  if (input.length > 20) return { ok: false, error: 'A painting can belong to at most 20 collections.' };

  const cleaned = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return { ok: false, error: 'Each collection name must be text.' };
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.length > 40) return { ok: false, error: 'Collection names must be 40 characters or fewer.' };
    if (/[<>]/.test(trimmed)) return { ok: false, error: 'Collection names must not contain HTML characters.' };
    const clean = sanitizeString(trimmed);
    if (!cleaned.includes(clean)) cleaned.push(clean);
  }
  return { ok: true, value: cleaned };
}

/**
 * Deletes a single blob URL from Vercel Blob storage.
 * Silent on failure — stale blobs are harmless.
 */
async function deleteBlob(url) {
  if (!url || !url.includes('blob.vercel-storage.com')) return;
  try { await del(url); } catch (e) { console.warn('blob delete failed:', e.message); }
}

/**
 * Deletes all blob URLs in an images array.
 */
async function deleteAllBlobs(images = []) {
  await Promise.all(images.map(url => deleteBlob(url)));
}

/**
 * Fetches an image from an external URL (Gelato's product preview) and
 * re-uploads it to Vercel Blob under our own storage, returning the
 * resulting permanent URL. Used by "Import photo from Gelato" (see
 * importGelatoPreviewImage below the fetch helper, and the POST/PUT
 * handlers) so a listing's image is a stable copy we control, not a link
 * to a Gelato-hosted URL that isn't guaranteed to stay valid forever.
 *
 * Server-side fetch — unlike a browser fetch(), this is never blocked by
 * CORS, which a client-side "download and re-upload" approach would risk
 * hitting if Gelato's preview CDN doesn't set permissive CORS headers.
 *
 * @param {string} sourceUrl
 * @returns {Promise<{ ok: boolean, url?: string, thumbUrl?: string, error?: string }>}
 */
async function importGelatoPreviewImage(sourceUrl) {
  if (!sourceUrl || typeof sourceUrl !== 'string' || !/^https:\/\//.test(sourceUrl)) {
    return { ok: false, error: 'Invalid image URL.' };
  }

  let res;
  try {
    res = await fetch(sourceUrl);
  } catch (err) {
    console.error('Gelato preview image fetch error:', err);
    return { ok: false, error: 'Could not download the image from Gelato.' };
  }
  if (!res.ok) {
    return { ok: false, error: `Could not download the image from Gelato (HTTP ${res.status}).` };
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) {
    return { ok: false, error: 'Gelato did not return an image file.' };
  }

  // Same 4MB ceiling the manual upload path enforces (per apiFetch's 413
  // handling in script.js) — keeps this path consistent with what an
  // admin uploading a photo by hand is already limited to.
  const MAX_BYTES = 4 * 1024 * 1024;
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) {
    return { ok: false, error: 'Gelato’s preview image is too large (over 4MB).' };
  }

  // ── Compress into full + thumbnail variants (or pass through) ────────
  // Same pipeline the manual upload routes use (upload-image.js,
  // update-artist-photo.js) and the same admin-controlled settings — a
  // Gelato-imported preview is still a photo that gets served to every
  // gallery visitor, so it counts toward Blob Data Transfer exactly like
  // a hand-uploaded one and should be sized the same way, including the
  // separate small thumbnail used for the gallery grid (see
  // _imageCompress.js compressToVariants).
  let fullBuffer  = buffer, fullContentType  = contentType, fullExt  = contentType.split('/')[1]?.split(';')[0] || 'jpg';
  let thumbBuffer = buffer, thumbContentType = contentType, thumbExt = fullExt;
  const settings = await getImageSettings();
  if (settings.enabled) {
    const dataUri  = `data:${contentType};base64,${buffer.toString('base64')}`;
    const variants = await compressToVariants(dataUri, settings);
    if (variants.ok) {
      fullBuffer  = variants.full.buffer;  fullContentType  = variants.full.mimeType;  fullExt  = variants.full.ext;
      thumbBuffer = variants.thumb.buffer; thumbContentType = variants.thumb.mimeType; thumbExt = variants.thumb.ext;
    } else {
      console.error('Compression failed for Gelato preview import — storing original:', variants.error);
    }
  }

  const stamp    = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pathname      = `artworks/gelato-import-${stamp}.${fullExt}`;
  const thumbPathname = `artworks/gelato-import-${stamp}-thumb.${thumbExt}`;

  try {
    const blob = await put(pathname, fullBuffer, { access: 'public', contentType: fullContentType });
    let thumbUrl = blob.url;
    try {
      const thumbBlob = await put(thumbPathname, thumbBuffer, { access: 'public', contentType: thumbContentType });
      thumbUrl = thumbBlob.url;
    } catch (err) {
      console.error('Gelato preview thumbnail blob upload error — falling back to full image:', err);
    }
    return { ok: true, url: blob.url, thumbUrl };
  } catch (err) {
    console.error('Gelato preview image blob upload error:', err);
    return { ok: false, error: 'Could not save the imported image.' };
  }
}

/**
 * Fetches an already-stored image (one of our own Blob URLs) and produces
 * just a thumbnail variant for it, uploaded alongside the original. Used
 * only by the 'backfill-thumbnails' PATCH action below, to retroactively
 * generate thumbnails for photos that were uploaded before the two-tier
 * thumbnail system existed (see _imageCompress.js / upload-image.js).
 *
 * @param {string} imageUrl - existing full-size Blob URL to derive a
 *   thumbnail from.
 * @param {{ thumbMaxDimension: number, thumbQuality: number }} settings
 * @returns {Promise<{ ok: boolean, thumbUrl?: string, error?: string }>}
 */
async function backfillThumbnailForImage(imageUrl, settings) {
  if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.includes('blob.vercel-storage.com')) {
    return { ok: false, error: 'Not a recognised image URL.' };
  }

  let res;
  try {
    res = await fetch(imageUrl);
  } catch (err) {
    return { ok: false, error: 'Could not download the existing image.' };
  }
  if (!res.ok) return { ok: false, error: `Could not download the existing image (HTTP ${res.status}).` };

  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buffer       = Buffer.from(await res.arrayBuffer());
  const dataUri       = `data:${contentType};base64,${buffer.toString('base64')}`;

  const thumb = await compressImage(dataUri, { maxDimension: settings.thumbMaxDimension, quality: settings.thumbQuality });
  if (!thumb.ok) return { ok: false, error: thumb.error };

  // Derive the thumbnail's blob pathname from the original's own pathname
  // (everything after the last '/'), so it sits next to the full image in
  // the same 'paintings/' or 'artworks/' folder, e.g.
  // paintings/painting-123-456-0.jpg -> paintings/painting-123-456-0-backfilled-thumb.jpg
  let baseName = 'backfilled';
  try {
    const parts = new URL(imageUrl).pathname.split('/');
    const last  = parts[parts.length - 1] || '';
    baseName    = last.replace(/\.[^.]+$/, '') || 'backfilled';
  } catch { /* fall back to the default baseName above */ }

  const thumbPathname = `paintings/${baseName}-backfilled-thumb-${Date.now()}.${thumb.ext}`;

  try {
    const thumbBlob = await put(thumbPathname, thumb.buffer, { access: 'public', contentType: thumb.mimeType });
    return { ok: true, thumbUrl: thumbBlob.url };
  } catch (err) {
    console.error('Backfill thumbnail blob upload error:', err);
    return { ok: false, error: 'Could not save the generated thumbnail.' };
  }
}

/**
 * Fetches Michael's connected Gelato store's product list, flattened to
 * one entry per variant (a variant is what actually maps to a Product UID,
 * e.g. one entry per print size).
 *
 * Requires GELATO_API_KEY and GELATO_STORE_ID env vars. This is an
 * OPTIONAL convenience — if either is missing, admins can still create a
 * Gelato print listing by pasting a Product UID in manually (copied from
 * Gelato's own product page), so this failing gracefully never blocks
 * the print-listing feature itself.
 *
 * Each entry also carries `previewUrl` — the product's own preview image
 * on Gelato's side (`previewUrl`, falling back to `externalThumbnailUrl`,
 * per Gelato's Ecommerce API product schema) — so the admin can see what
 * they're importing, and optionally pull it in as the listing's own photo
 * (see importGelatoPreviewImage above) instead of uploading one by hand.
 * A variant with no previewUrl on Gelato's side just gets null here — the
 * manual upload flow remains the fallback either way.
 *
 * @returns {Promise<{ ok: boolean, products?: Array, error?: string }>}
 */
async function fetchGelatoStoreProducts() {
  const apiKey  = process.env.GELATO_API_KEY;
  const storeId = process.env.GELATO_STORE_ID;

  if (!apiKey || !storeId) {
    return {
      ok:    false,
      error: 'Gelato store is not connected (GELATO_API_KEY or GELATO_STORE_ID missing). You can still create a print listing by entering the Product UID manually.',
    };
  }

  try {
    const res = await fetch(
      `${GELATO_ECOMMERCE_API}/v1/stores/${encodeURIComponent(storeId)}/products?limit=100&orderBy=createdAt&order=desc`,
      { headers: { 'X-API-KEY': apiKey } }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('Gelato products fetch failed:', res.status, body);
      return { ok: false, error: 'Could not reach Gelato. Please try again, or enter the Product UID manually.' };
    }

    const data = await res.json();
    // Response shape (per Gelato's Ecommerce API): a list of store products,
    // each with a title and an array of variants (size/style options),
    // each variant carrying the productUid used for ordering + printing.
    const rawProducts = Array.isArray(data.products) ? data.products
                       : Array.isArray(data)          ? data
                       : [];

    // Flatten to one row per variant — that's the unit a print listing maps to.
    const flattened = [];
    for (const product of rawProducts) {
      const variants = Array.isArray(product.variants) ? product.variants : [];
      if (variants.length === 0) continue;
      // Preview image lives at the PRODUCT level (not per-variant) in
      // Gelato's schema — every variant of this product shares it.
      const previewUrl = product.previewUrl || product.externalThumbnailUrl || product.externalPreviewUrl || null;
      for (const variant of variants) {
        if (!variant.productUid) continue;
        flattened.push({
          storeProductId: product.id || null,
          productTitle:   product.title || 'Untitled Gelato product',
          variantTitle:   variant.title || '',
          productUid:     variant.productUid,
          previewUrl,
        });
      }
    }

    return { ok: true, products: flattened };

  } catch (err) {
    console.error('Gelato products fetch error:', err);
    return { ok: false, error: 'Could not reach Gelato. Please try again, or enter the Product UID manually.' };
  }
}

/**
 * /api/paintings — consolidated paintings management endpoint
 *
 * GET    → (admin only) fetch Michael's connected Gelato store's product
 *           list, for the "Import from Gelato" convenience button in the
 *           add-painting panel. Returns products flattened to one entry
 *           per variant, each carrying a `previewUrl` when Gelato has one.
 *           Never required — Product UID can always be typed in manually
 *           instead, and a photo always be uploaded by hand instead.
 * POST   → create a new painting record
 * PUT    → update painting metadata + optionally remove specific images
 * DELETE → delete a painting and all its associated blobs from CDN
 * PATCH  → toggle sold status (default), OR reorder listings within one
 *           gallery section when the body carries { action: 'reorder' }
 *           (Task 4 — see the PATCH case below)
 *
 * Task 4 additions (admin editing/reordering/collections):
 *   order       — display-order number. Defaults to the same value as
 *                  `id` at creation time, so existing/never-reordered
 *                  listings keep exactly the order they already render
 *                  in today (array/insertion order) with zero migration.
 *                  Only ever changed via PATCH { action: 'reorder' }.
 *                  Sorting by this field is scoped per category and done
 *                  client-side in script.js — this endpoint only persists
 *                  the value, it never sorts or reads order itself.
 *   collections — free-text array of collection names Michael assigns to
 *                  a painting (admin organisation + a public filter bar).
 *                  Defaults to [] when absent.
 *
 * Listing types (via the `source` and `oversized` fields):
 *   source: 'original',       oversized: false → standard painting, AusPost shipping
 *   source: 'original',       oversized: true  → freight/contact-artist listing
 *   source: 'gelato',         oversized: false → print-on-demand listing, fulfilled
 *                                                 and shipped by Gelato — no AusPost
 *                                                 shipping dimensions needed, unlimited
 *                                                 (never auto-marked sold by a purchase)
 *   source: 'original-print', oversized: false → fixed, limited print run, fulfilled
 *                                                 manually and shipped via AusPost like
 *                                                 a standard listing, but with a fixed
 *                                                 `stockLimit`. See stock fields below.
 *
 * Original Print stock fields:
 *   stockLimit — admin-set total copies available for this listing (positive
 *                integer). Required, and editable later (raising the run size,
 *                for instance), but can never be edited below stockSold.
 *   stockSold  — running count of copies actually purchased through checkout.
 *                NOT admin-editable directly — it only ever increments, in
 *                create-payment.js, after a successful payment. Once
 *                stockSold reaches stockLimit the listing is automatically
 *                flipped to sold/unavailable — no manual flipping needed per
 *                sale (this is what distinguishes it from a Gelato print,
 *                which is unlimited/print-on-demand and never auto-sells-out).
 *
 * Gelato print listings additionally carry:
 *   gelatoProductUid — the Gelato product/variant UID used to submit the
 *                       print job and request shipping quotes
 *   printGroupId      — an admin-assigned string shared by all size variants
 *                        of the same painting, so the gallery can group them
 *                        into a single card with a size picker (see script.js)
 *   variantLabel      — the human-readable size/option label, e.g. "A4"
 *
 * Gelato listings still have their own fixed `price`, `images`, `title`
 * etc. exactly like any other painting — Michael sets the retail price and
 * photos himself; Gelato only supplies the fulfillment ID. Photos can
 * either be uploaded by hand (existing flow, via /api/upload-image) or, as
 * of this change, imported directly from the Gelato product's own preview
 * image via the optional `gelatoPreviewUrl` field on POST/PUT below.
 */
export default async function handler(req, res) {
  const ip = getIp(req);

  // ── Shared: body size limit ───────────────────────────────────────────
  // PATCH gets its own, slightly larger cap than the plain 1kb sold-toggle
  // body — a reorder PATCH carries an array of every artwork id in one
  // gallery section (up to ~80 paintings per Michael's current catalogue,
  // per the project summary), comfortably under 4kb but over 1kb.
  const maxSize =
    req.method === 'POST' || req.method === 'PUT' ? '10kb' :
    req.method === 'PATCH' ? '4kb' :
    '1kb';
  const size    = checkBodySize(req, maxSize);
  if (!size.ok) return res.status(413).json({ error: size.error });

  // ── Shared: auth ──────────────────────────────────────────────────────
  const admin = await verifyAdmin(req);
  if (!admin) {
    await auditLog({ action: 'unauthorised', ip, detail: { endpoint: 'paintings', method: req.method } });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Shared: CSRF ──────────────────────────────────────────────────────
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    await auditLog({ action: 'csrf_rejected', ip, detail: { endpoint: 'paintings', reason: csrf.reason } });
    return res.status(403).json({ error: 'Forbidden' });
  }

  switch (req.method) {

    // ── GET — fetch Gelato store products for import, or image settings ──
    // ?action=image-settings returns the admin's current upload-time
    // compression settings (see _imageSettings.js) for the Image Settings
    // panel in script.js. Anything else (the default — no query string)
    // keeps the existing Gelato product-import behaviour unchanged, so
    // this stays backward compatible with every existing caller.
    case 'GET': {
      if (req.query?.action === 'image-settings') {
        const settings = await getImageSettings();
        return res.status(200).json({ success: true, settings });
      }

      const result = await fetchGelatoStoreProducts();
      if (!result.ok) {
        // Not configured / unreachable — return gracefully, never a hard error.
        // The frontend shows this as a message and falls back to manual entry.
        return res.status(200).json({ success: false, error: result.error });
      }
      return res.status(200).json({ success: true, products: result.products });
    }

    // ── POST — create painting record ───────────────────────────────────
    case 'POST': {
      const {
        title, medium, price, sold = false,
        category  = 'seascape',
        oversized = false,
        source    = 'original',
        gelatoProductUid = null,
        printGroupId     = null,
        variantLabel     = null,
        collections      = [],
        weight, length, width, height,
        gelatoPreviewUrl = null,
        stockLimit       = null,
      } = req.body || {};

      // ── Validate text fields ────────────────────────────────────────
      if (!isValidString(title) || !isValidString(medium) || typeof price !== 'number' || price < 0) {
        return res.status(400).json({ success: false, error: 'Invalid artwork data.' });
      }
      if (!['seascape', 'figurative'].includes(category)) {
        return res.status(400).json({ success: false, error: 'Invalid category. Must be seascape or figurative.' });
      }
      if (!['original', 'gelato', 'original-print'].includes(source)) {
        return res.status(400).json({ success: false, error: 'Invalid listing source.' });
      }

      const caps = capFields([['Title', title, 200], ['Medium', medium, 300]]);
      if (!caps.ok) return res.status(400).json({ success: false, error: caps.error });

      const collVal = validateCollections(collections);
      if (!collVal.ok) return res.status(400).json({ success: false, error: collVal.error });

      // A Gelato print listing can't also be "oversized" — Gelato handles
      // its own shipping regardless of size, so the flag is meaningless there.
      const isOversized = source === 'gelato' ? false : Boolean(oversized);

      // ── Gelato-specific fields ──────────────────────────────────────
      let gelatoFields = { gelatoProductUid: null };
      if (source === 'gelato') {
        if (!isValidString(gelatoProductUid)) {
          return res.status(400).json({ success: false, error: 'A Gelato Product UID is required for print listings.' });
        }
        // 300, not a round "reasonable text field" number like 40/100 —
        // gelatoProductUid is an opaque ID pasted verbatim from Gelato
        // (or filled by the Import button), not text the admin can
        // shorten, and Gelato's real catalog UIDs are long descriptive
        // slugs (product + size + material + colour codes concatenated)
        // that can genuinely exceed 100 characters. A too-low cap here
        // would silently block a legitimate listing with no workaround.
        const gelatoCaps = capFields([['Gelato Product UID', gelatoProductUid, 300]]);
        if (!gelatoCaps.ok) return res.status(400).json({ success: false, error: gelatoCaps.error });

        gelatoFields = { gelatoProductUid: String(gelatoProductUid).trim() };
      }

      // ── Grouping (Print group / Size label) — for multi-size listings ─
      // Combines listings that share a printGroupId into one gallery card
      // with a size picker (see groupArtworksByPrintGroup in script.js).
      // Available to both Gelato print-on-demand AND Original Print
      // (limited run) listings — either can be offered in more than one
      // size, each size its own record (own price/stock/images) sharing
      // one printGroupId. Not meaningful for a one-of-a-kind standard
      // Original or an Oversized freight listing, so left null there
      // regardless of what's sent.
      let groupingFields = { printGroupId: null, variantLabel: null };
      if (source === 'gelato' || source === 'original-print') {
        const groupCaps = capFields([
          ...(printGroupId ? [['Print group', String(printGroupId), 100]] : []),
          ...(variantLabel ? [['Size label', String(variantLabel), 40]] : []),
        ]);
        if (!groupCaps.ok) return res.status(400).json({ success: false, error: groupCaps.error });

        groupingFields = {
          printGroupId: printGroupId ? String(printGroupId).trim() : null,
          variantLabel: variantLabel ? sanitizeString(String(variantLabel)) : null,
        };
      }

      // ── Original Print stock fields ──────────────────────────────────
      // A brand-new listing always starts at stockSold: 0 — stockSold only
      // ever increments later, from create-payment.js after a real sale.
      let stockFields = { stockLimit: null, stockSold: 0 };
      if (source === 'original-print') {
        const parsedLimit = parseInt(stockLimit, 10);
        if (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > 100000) {
          return res.status(400).json({ success: false, error: 'A stock quantity of 1 or more is required for Original Print listings.' });
        }
        stockFields = { stockLimit: parsedLimit, stockSold: 0 };
      }

      // ── Shipping dimensions — only for standard (non-oversized, non-Gelato) ─
      // Original Print listings ship exactly like a standard Original via
      // AusPost, so they go through this same block (only Gelato is excluded).
      let shipping = null;
      if (!isOversized && source !== 'gelato') {
        for (const [key, val] of Object.entries({ weight, length, width, height })) {
          if (isNaN(parseFloat(val)) || parseFloat(val) <= 0) {
            return res.status(400).json({ success: false, error: `Shipping ${key} is required and must be a positive number.` });
          }
        }
        shipping = {
          weight: parseFloat(weight),
          length: parseFloat(length),
          width:  parseFloat(width),
          height: parseFloat(height),
        };
      }

      // ── Optional: import the Gelato product's own preview image ──────
      // Only meaningful for a Gelato listing. Runs before the record is
      // saved so the very first save already has an image, same as if the
      // admin had uploaded one by hand — no separate second step needed.
      // Never blocks creating the listing: an import failure just leaves
      // images empty, exactly like today, with the reason reported back so
      // the admin can fall back to uploading a photo manually.
      let importedImageUrl = null;
      let importedThumbUrl = null;
      let importWarning     = null;
      if (source === 'gelato' && gelatoPreviewUrl) {
        const imported = await importGelatoPreviewImage(gelatoPreviewUrl);
        if (imported.ok) {
          importedImageUrl = imported.url;
          importedThumbUrl = imported.thumbUrl || imported.url;
        } else {
          importWarning = imported.error;
        }
      }

      // ── Save record ───────────────────────────────────────────────────
      const id       = Date.now();
      const artworks = (await redis.get('artworks')) || [];
      artworks.push({
        id,
        // Defaults to the id itself — a fresh Date.now() timestamp — so a
        // brand-new listing naturally sorts after every existing one
        // without needing to know any other artwork's order value.
        order: id,
        category,
        title:       sanitizeString(title),
        medium:      sanitizeString(medium),
        price,
        sold:        Boolean(sold),
        oversized:   isOversized,
        source,
        collections: collVal.value,
        ...gelatoFields,
        ...groupingFields,
        ...stockFields,
        images:     importedImageUrl ? [importedImageUrl] : [],
        thumbnails: importedImageUrl ? [importedThumbUrl] : [],
        imgUrl:  null,
        imgData: null,
        svg:     null,
        shipping,
      });
      await redis.set('artworks', artworks);
      await auditLog({ action: 'add_painting', ip, detail: { id, title: sanitizeString(title), price, source, oversized: isOversized, stockLimit: stockFields.stockLimit, printGroupId: groupingFields.printGroupId, importedGelatoImage: !!importedImageUrl } });

      return res.status(200).json({ success: true, id, ...(importWarning ? { imageImportWarning: importWarning } : {}) });
    }

    // ── PUT — update painting metadata ──────────────────────────────────
    case 'PUT': {
      const {
        id, title, medium, price, sold,
        oversized,
        source = 'original',
        gelatoProductUid = null,
        printGroupId     = null,
        variantLabel     = null,
        removeImageUrls = [],
        collections      = [],
        weight, length, width, height,
        gelatoPreviewUrl = null,
        stockLimit       = null,
      } = req.body || {};

      // ── Validate text fields ────────────────────────────────────────
      if (!id || !isValidString(title) || !isValidString(medium) || typeof price !== 'number' || price < 0) {
        return res.status(400).json({ success: false, error: 'Invalid artwork data.' });
      }
      if (!['original', 'gelato', 'original-print'].includes(source)) {
        return res.status(400).json({ success: false, error: 'Invalid listing source.' });
      }

      const caps = capFields([['Title', title, 200], ['Medium', medium, 300]]);
      if (!caps.ok) return res.status(400).json({ success: false, error: caps.error });

      const collVal = validateCollections(collections);
      if (!collVal.ok) return res.status(400).json({ success: false, error: collVal.error });

      if (!Array.isArray(removeImageUrls)) {
        return res.status(400).json({ success: false, error: 'removeImageUrls must be an array.' });
      }

      const isOversized = source === 'gelato' ? false : Boolean(oversized);

      // ── Gelato-specific fields ──────────────────────────────────────
      let gelatoFields = { gelatoProductUid: null };
      if (source === 'gelato') {
        if (!isValidString(gelatoProductUid)) {
          return res.status(400).json({ success: false, error: 'A Gelato Product UID is required for print listings.' });
        }
        // 300, not a round "reasonable text field" number like 40/100 —
        // gelatoProductUid is an opaque ID pasted verbatim from Gelato
        // (or filled by the Import button), not text the admin can
        // shorten, and Gelato's real catalog UIDs are long descriptive
        // slugs (product + size + material + colour codes concatenated)
        // that can genuinely exceed 100 characters. A too-low cap here
        // would silently block a legitimate listing with no workaround.
        const gelatoCaps = capFields([['Gelato Product UID', gelatoProductUid, 300]]);
        if (!gelatoCaps.ok) return res.status(400).json({ success: false, error: gelatoCaps.error });

        gelatoFields = { gelatoProductUid: String(gelatoProductUid).trim() };
      }

      // ── Grouping (Print group / Size label) — for multi-size listings ─
      // See the matching comment in the POST handler above — same rule:
      // available to Gelato and Original Print listings, null otherwise.
      let groupingFields = { printGroupId: null, variantLabel: null };
      if (source === 'gelato' || source === 'original-print') {
        const groupCaps = capFields([
          ...(printGroupId ? [['Print group', String(printGroupId), 100]] : []),
          ...(variantLabel ? [['Size label', String(variantLabel), 40]] : []),
        ]);
        if (!groupCaps.ok) return res.status(400).json({ success: false, error: groupCaps.error });

        groupingFields = {
          printGroupId: printGroupId ? String(printGroupId).trim() : null,
          variantLabel: variantLabel ? sanitizeString(String(variantLabel)) : null,
        };
      }

      // ── Shipping dimensions — only for standard listings ─────────────
      let shipping = null;
      if (!isOversized && source !== 'gelato') {
        for (const [key, val] of Object.entries({ weight, length, width, height })) {
          if (isNaN(parseFloat(val)) || parseFloat(val) <= 0) {
            return res.status(400).json({ success: false, error: `Shipping ${key} is required and must be a positive number.` });
          }
        }
        shipping = {
          weight: parseFloat(weight),
          length: parseFloat(length),
          width:  parseFloat(width),
          height: parseFloat(height),
        };
      }

      // ── Fetch existing artwork ──────────────────────────────────────
      let artworks = (await redis.get('artworks')) || [];
      const numId  = Number(id);
      const idx    = artworks.findIndex(a => Number(a.id) === numId);
      if (idx === -1) return res.status(404).json({ success: false, error: 'Artwork not found.' });
      const existingForStock = artworks[idx];

      // ── Original Print stock fields ──────────────────────────────────
      // stockSold carries over from the existing record — it's never reset
      // by an edit, only ever incremented by create-payment.js after a real
      // sale. The admin can raise (or lower, down to what's already sold)
      // stockLimit here; lowering it below stockSold is rejected outright
      // rather than silently clamped, since that would misrepresent how
      // many copies have actually been sold.
      let stockFields = { stockLimit: null, stockSold: 0 };
      let autoSoldOut = false;
      if (source === 'original-print') {
        const parsedLimit = parseInt(stockLimit, 10);
        if (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > 100000) {
          return res.status(400).json({ success: false, error: 'A stock quantity of 1 or more is required for Original Print listings.' });
        }
        const currentSold = existingForStock.source === 'original-print' && typeof existingForStock.stockSold === 'number'
          ? existingForStock.stockSold
          : 0;
        if (parsedLimit < currentSold) {
          return res.status(400).json({ success: false, error: `Stock quantity can't be set below the ${currentSold} already sold.` });
        }
        stockFields = { stockLimit: parsedLimit, stockSold: currentSold };
        autoSoldOut = currentSold >= parsedLimit;
      }

      // ── Normalise images[] / thumbnails[] ─────────────────────────────
      // thumbnails[] is kept parallel to images[] (same length, same
      // order) — a null entry means "no thumbnail yet for this image"
      // (pre-existing photo, not yet backfilled — see
      // backfillThumbnailForImage / the 'backfill-thumbnails' PATCH
      // action below), and the frontend falls back to the full image for
      // that slot. Padded to the same length as currentImages so index
      // correspondence always holds, even for records saved before this
      // field existed.
      const existing     = artworks[idx];
      let currentImages  = Array.isArray(existing.images) && existing.images.length > 0
        ? [...existing.images]
        : (existing.imgUrl ? [existing.imgUrl] : []);
      let currentThumbnails = Array.isArray(existing.thumbnails) ? [...existing.thumbnails] : [];
      while (currentThumbnails.length < currentImages.length) currentThumbnails.push(null);

      // ── Remove flagged images (and their paired thumbnail) ────────────
      const safeToRemove = removeImageUrls.filter(url =>
        typeof url === 'string' &&
        url.includes('blob.vercel-storage.com') &&
        currentImages.includes(url)
      );
      const thumbsToDelete = [];
      const keptImages = [], keptThumbnails = [];
      currentImages.forEach((url, i) => {
        if (safeToRemove.includes(url)) {
          if (currentThumbnails[i]) thumbsToDelete.push(currentThumbnails[i]);
          return;
        }
        keptImages.push(url);
        keptThumbnails.push(currentThumbnails[i] ?? null);
      });
      await Promise.all(safeToRemove.map(url => deleteBlob(url)));
      await Promise.all(thumbsToDelete.map(url => deleteBlob(url)));
      currentImages     = keptImages;
      currentThumbnails = keptThumbnails;

      // ── Optional: import the Gelato product's own preview image ──────
      // Same as the POST path above — never blocks saving the rest of the
      // edit. Added to the FRONT of the images array only when this
      // listing currently has no photo at all, so importing never bumps a
      // photo the admin already deliberately chose as the hero image; if
      // it already has photos, the import is appended instead. The
      // thumbnail is kept in lockstep at the same index.
      let importWarning = null;
      if (source === 'gelato' && gelatoPreviewUrl) {
        const imported = await importGelatoPreviewImage(gelatoPreviewUrl);
        if (imported.ok) {
          const importedThumb = imported.thumbUrl || imported.url;
          if (currentImages.length === 0) {
            currentImages     = [imported.url];
            currentThumbnails = [importedThumb];
          } else {
            currentImages     = [...currentImages, imported.url];
            currentThumbnails = [...currentThumbnails, importedThumb];
          }
        } else {
          importWarning = imported.error;
        }
      }

      // ── Save updated record ───────────────────────────────────────────
      // `order` is deliberately left out of this object — it's not one of
      // the spread-then-overwritten keys below, so it carries through
      // unchanged from `existing`. Editing a listing never moves it;
      // only PATCH { action: 'reorder' } (below) ever changes order.
      artworks[idx] = {
        ...existing,
        title:       sanitizeString(title),
        medium:      sanitizeString(medium),
        price,
        // Auto-sold-out (source === 'original-print' and every copy is
        // already accounted for) always wins over an admin trying to
        // uncheck "sold" — it reasserts on the next save so the listing
        // can't be reopened just by raising stockLimit back down again.
        sold:        source === 'original-print' ? (Boolean(sold) || autoSoldOut) : Boolean(sold),
        oversized:   isOversized,
        source,
        collections: collVal.value,
        ...gelatoFields,
        ...groupingFields,
        ...stockFields,
        images:     currentImages,
        thumbnails: currentThumbnails,
        imgUrl:  null,
        imgData: null,
        shipping,
      };

      await redis.set('artworks', artworks);
      await auditLog({ action: 'update_painting', ip, detail: { id: numId, title: sanitizeString(title), price, source, stockLimit: stockFields.stockLimit, imageCount: currentImages.length } });
      return res.status(200).json({ success: true, ...(importWarning ? { imageImportWarning: importWarning } : {}) });
    }

    // ── DELETE — remove painting and all its blobs ──────────────────────
    case 'DELETE': {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ success: false, error: 'Missing id.' });

      let artworks = (await redis.get('artworks')) || [];
      const numId  = Number(id);
      const target = artworks.find(a => Number(a.id) === numId);
      if (!target) return res.status(404).json({ success: false, error: 'Artwork not found.' });

      const blobsToDelete = Array.isArray(target.images) && target.images.length > 0
        ? target.images
        : (target.imgUrl ? [target.imgUrl] : []);
      const thumbsToDelete = Array.isArray(target.thumbnails) ? target.thumbnails.filter(Boolean) : [];
      await deleteAllBlobs(blobsToDelete);
      await deleteAllBlobs(thumbsToDelete);

      artworks = artworks.filter(a => Number(a.id) !== numId);
      await redis.set('artworks', artworks);
      await auditLog({ action: 'delete_painting', ip, detail: { id: numId, title: target.title } });
      return res.status(200).json({ success: true });
    }

    // ── PATCH — toggle sold status (default), or reorder (Task 4) ────────
    case 'PATCH': {
      const {
        action, id, order,
        enabled, maxDimension, quality, thumbMaxDimension, thumbQuality,
        batchSize,
      } = req.body || {};

      // ── Update image compression settings ─────────────────────────────
      // Body: { action: 'update-image-settings', enabled, maxDimension,
      // quality, thumbMaxDimension, thumbQuality } — see _imageSettings.js
      // for what each field means and its valid range. Takes effect on the
      // very next upload through any route (upload-image.js,
      // update-artist-photo.js, the Gelato-preview import above) — no
      // redeploy needed.
      if (action === 'update-image-settings') {
        const validated = validateImageSettings({ enabled, maxDimension, quality, thumbMaxDimension, thumbQuality });
        if (!validated.ok) {
          return res.status(400).json({ success: false, error: validated.error });
        }
        await saveImageSettings(validated.value);
        await auditLog({ action: 'update_image_settings', ip, detail: validated.value });
        return res.status(200).json({ success: true, settings: validated.value });
      }

      // ── Backfill thumbnails for existing photos ───────────────────────
      // Body: { action: 'backfill-thumbnails', batchSize? }. Processes a
      // small batch of images that are missing a thumbnail (thumbnails[i]
      // is null/absent) per call, generating one via
      // backfillThumbnailForImage() and saving it into that artwork's
      // thumbnails[] array. Deliberately batched rather than doing the
      // whole catalogue in one request — Vercel serverless functions have
      // a execution time limit, and Michael's catalogue (~60-80 paintings,
      // several photos each) is comfortably too much to process in one
      // call. The frontend (script.js) loops this endpoint, showing
      // progress, until `remaining` reaches 0.
      if (action === 'backfill-thumbnails') {
        const parsedBatch = parseInt(batchSize, 10);
        const limit = Number.isFinite(parsedBatch) ? Math.min(Math.max(parsedBatch, 1), 20) : 8;

        let artworks = (await redis.get('artworks')) || [];
        const settings = await getImageSettings();

        // Build a flat worklist of every (artwork index, image index) pair
        // that's missing a thumbnail, across the whole catalogue, so the
        // batch limit applies globally rather than per-artwork.
        const worklist = [];
        artworks.forEach((art, aIdx) => {
          const images = Array.isArray(art.images) ? art.images : [];
          const thumbs = Array.isArray(art.thumbnails) ? art.thumbnails : [];
          images.forEach((imgUrl, iIdx) => {
            if (imgUrl && !thumbs[iIdx]) worklist.push({ aIdx, iIdx, imgUrl });
          });
        });

        const totalRemainingBefore = worklist.length;
        const batch = worklist.slice(0, limit);

        let processed = 0, failed = 0;
        for (const { aIdx, iIdx, imgUrl } of batch) {
          const result = await backfillThumbnailForImage(imgUrl, settings);
          const art = artworks[aIdx];
          if (!Array.isArray(art.thumbnails)) art.thumbnails = [];
          while (art.thumbnails.length < art.images.length) art.thumbnails.push(null);
          if (result.ok) {
            art.thumbnails[iIdx] = result.thumbUrl;
            processed++;
          } else {
            // Leave as null — it'll be retried on the next backfill call
            // rather than falling back to the full image forever.
            console.error(`Backfill thumbnail failed for artwork ${art.id} image ${iIdx}:`, result.error);
            failed++;
          }
        }

        if (batch.length > 0) await redis.set('artworks', artworks);
        const remaining = totalRemainingBefore - processed;
        await auditLog({ action: 'backfill_thumbnails', ip, detail: { processed, failed, remaining } });
        return res.status(200).json({ success: true, processed, failed, remaining, total: totalRemainingBefore });
      }

      // ── Reorder — admin drag-and-drop within one gallery section ─────
      // `order` is an array of artwork ids in their new top-to-bottom
      // sequence. It's always scoped to a single gallery section (the
      // admin only ever drags within one of #gallery-seascapes /
      // #gallery-figurative — see script.js), so each listed id's
      // `order` field is set to its index in that array; every artwork
      // NOT in the list (including the other category entirely) is left
      // completely untouched. Because sorting-by-order always happens
      // after category filtering (client-side, in script.js), reused
      // index values across the two categories never collide.
      if (action === 'reorder') {
        if (!Array.isArray(order) || order.length === 0 || order.length > 200) {
          return res.status(400).json({ success: false, error: 'Invalid reorder list.' });
        }
        const ids = order.map(Number);
        if (ids.some(n => !Number.isFinite(n))) {
          return res.status(400).json({ success: false, error: 'Invalid reorder list.' });
        }

        let artworks = (await redis.get('artworks')) || [];
        const byId = new Map(artworks.map(a => [Number(a.id), a]));
        ids.forEach((artId, index) => {
          const art = byId.get(artId);
          if (art) art.order = index;
        });

        await redis.set('artworks', artworks);
        await auditLog({ action: 'reorder_paintings', ip, detail: { count: ids.length } });
        return res.status(200).json({ success: true });
      }

      // ── Toggle sold status (default / existing behaviour) ─────────────
      // Note: for Gelato print listings, "sold" is only ever a manual admin
      // action (e.g. discontinuing a print offering). A purchase through
      // checkout never sets this automatically — see create-payment.js —
      // because prints are not one-of-a-kind and remain available to other
      // buyers after a sale.
      if (!id) return res.status(400).json({ success: false, error: 'Missing id.' });

      let artworks = (await redis.get('artworks')) || [];
      const numId  = Number(id);
      const idx    = artworks.findIndex(a => Number(a.id) === numId);
      if (idx === -1) return res.status(404).json({ success: false, error: 'Artwork not found.' });

      artworks[idx].sold = !artworks[idx].sold;
      const newSold = artworks[idx].sold;
      await redis.set('artworks', artworks);
      await auditLog({ action: 'toggle_sold', ip, detail: { id: numId, title: artworks[idx].title, sold: newSold } });
      return res.status(200).json({ success: true, sold: newSold });
    }

    default:
      return res.status(405).json({ error: 'Method not allowed' });
  }
}
