import { Redis } from '@upstash/redis';
import { del, put } from '@vercel/blob';
import { verifyAdmin } from './_verifyAdmin.js';
import { sanitizeString, capFields } from './_sanitize.js';
import { getIp } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';
import { checkCsrf } from './_csrf.js';
import { checkBodySize } from './_bodyLimit.js';

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
 * @returns {Promise<{ ok: boolean, url?: string, error?: string }>}
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

  const ext = contentType.split('/')[1]?.split(';')[0] || 'jpg';
  const pathname = `artworks/gelato-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  try {
    const blob = await put(pathname, buffer, { access: 'public', contentType });
    return { ok: true, url: blob.url };
  } catch (err) {
    console.error('Gelato preview image blob upload error:', err);
    return { ok: false, error: 'Could not save the imported image.' };
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
 *   source: 'original', oversized: false  → standard painting, AusPost shipping
 *   source: 'original', oversized: true   → freight/contact-artist listing
 *   source: 'gelato',   oversized: false  → print-on-demand listing, fulfilled
 *                                            and shipped by Gelato — no AusPost
 *                                            shipping dimensions needed
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

    // ── GET — fetch Gelato store products for import ────────────────────
    case 'GET': {
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
      } = req.body || {};

      // ── Validate text fields ────────────────────────────────────────
      if (!isValidString(title) || !isValidString(medium) || typeof price !== 'number' || price < 0) {
        return res.status(400).json({ success: false, error: 'Invalid artwork data.' });
      }
      if (!['seascape', 'figurative'].includes(category)) {
        return res.status(400).json({ success: false, error: 'Invalid category. Must be seascape or figurative.' });
      }
      if (!['original', 'gelato'].includes(source)) {
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
      let gelatoFields = { gelatoProductUid: null, printGroupId: null, variantLabel: null };
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
        const gelatoCaps = capFields([
          ['Gelato Product UID', gelatoProductUid, 300],
          ...(printGroupId ? [['Print group', String(printGroupId), 100]] : []),
          ...(variantLabel ? [['Size label', String(variantLabel), 40]] : []),
        ]);
        if (!gelatoCaps.ok) return res.status(400).json({ success: false, error: gelatoCaps.error });

        gelatoFields = {
          gelatoProductUid: String(gelatoProductUid).trim(),
          printGroupId:     printGroupId ? String(printGroupId).trim() : null,
          variantLabel:     variantLabel ? sanitizeString(String(variantLabel)) : null,
        };
      }

      // ── Shipping dimensions — only for standard (non-oversized, non-Gelato) ─
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
      let importWarning     = null;
      if (source === 'gelato' && gelatoPreviewUrl) {
        const imported = await importGelatoPreviewImage(gelatoPreviewUrl);
        if (imported.ok) {
          importedImageUrl = imported.url;
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
        images:  importedImageUrl ? [importedImageUrl] : [],
        imgUrl:  null,
        imgData: null,
        svg:     null,
        shipping,
      });
      await redis.set('artworks', artworks);
      await auditLog({ action: 'add_painting', ip, detail: { id, title: sanitizeString(title), price, source, oversized: isOversized, importedGelatoImage: !!importedImageUrl } });

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
      } = req.body || {};

      // ── Validate text fields ────────────────────────────────────────
      if (!id || !isValidString(title) || !isValidString(medium) || typeof price !== 'number' || price < 0) {
        return res.status(400).json({ success: false, error: 'Invalid artwork data.' });
      }
      if (!['original', 'gelato'].includes(source)) {
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
      let gelatoFields = { gelatoProductUid: null, printGroupId: null, variantLabel: null };
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
        const gelatoCaps = capFields([
          ['Gelato Product UID', gelatoProductUid, 300],
          ...(printGroupId ? [['Print group', String(printGroupId), 100]] : []),
          ...(variantLabel ? [['Size label', String(variantLabel), 40]] : []),
        ]);
        if (!gelatoCaps.ok) return res.status(400).json({ success: false, error: gelatoCaps.error });

        gelatoFields = {
          gelatoProductUid: String(gelatoProductUid).trim(),
          printGroupId:     printGroupId ? String(printGroupId).trim() : null,
          variantLabel:     variantLabel ? sanitizeString(String(variantLabel)) : null,
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

      // ── Normalise images[] ────────────────────────────────────────────
      const existing     = artworks[idx];
      let currentImages  = Array.isArray(existing.images) && existing.images.length > 0
        ? [...existing.images]
        : (existing.imgUrl ? [existing.imgUrl] : []);

      // ── Remove flagged images ─────────────────────────────────────────
      const safeToRemove = removeImageUrls.filter(url =>
        typeof url === 'string' &&
        url.includes('blob.vercel-storage.com') &&
        currentImages.includes(url)
      );
      await Promise.all(safeToRemove.map(url => deleteBlob(url)));
      currentImages = currentImages.filter(url => !safeToRemove.includes(url));

      // ── Optional: import the Gelato product's own preview image ──────
      // Same as the POST path above — never blocks saving the rest of the
      // edit. Added to the FRONT of the images array only when this
      // listing currently has no photo at all, so importing never bumps a
      // photo the admin already deliberately chose as the hero image; if
      // it already has photos, the import is appended instead.
      let importWarning = null;
      if (source === 'gelato' && gelatoPreviewUrl) {
        const imported = await importGelatoPreviewImage(gelatoPreviewUrl);
        if (imported.ok) {
          currentImages = currentImages.length === 0
            ? [imported.url]
            : [...currentImages, imported.url];
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
        sold:        Boolean(sold),
        oversized:   isOversized,
        source,
        collections: collVal.value,
        ...gelatoFields,
        images:  currentImages,
        imgUrl:  null,
        imgData: null,
        shipping,
      };

      await redis.set('artworks', artworks);
      await auditLog({ action: 'update_painting', ip, detail: { id: numId, title: sanitizeString(title), price, source, imageCount: currentImages.length } });
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
      await deleteAllBlobs(blobsToDelete);

      artworks = artworks.filter(a => Number(a.id) !== numId);
      await redis.set('artworks', artworks);
      await auditLog({ action: 'delete_painting', ip, detail: { id: numId, title: target.title } });
      return res.status(200).json({ success: true });
    }

    // ── PATCH — toggle sold status (default), or reorder (Task 4) ────────
    case 'PATCH': {
      const { action, id, order } = req.body || {};

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
