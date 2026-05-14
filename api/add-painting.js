import { Redis } from '@upstash/redis';
import { verifyAdmin } from './_verifyAdmin.js';
import { sanitizeString, capFields } from './_sanitize.js';
import { getIp } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';
import { checkCsrf } from './_csrf.js';
import { checkBodySize } from './_bodyLimit.js';
import { validateImage } from './_imageValidator.js';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function isValidString(str) {
  return typeof str === 'string' && str.trim().length > 0 && !/[<>]/.test(str);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Body size limit (5mb — allows base64-encoded painting image) ──────
  const size = checkBodySize(req, '4mb');
  if (!size.ok) return res.status(413).json({ error: size.error });

  const admin = await verifyAdmin(req);
  if (!admin) {
    await auditLog({ action: 'unauthorised', ip: getIp(req), detail: { endpoint: 'add-painting' } });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    await auditLog({ action: 'csrf_rejected', ip: getIp(req), detail: { endpoint: 'add-painting', reason: csrf.reason } });
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { title, medium, price, sold = false, imgData = null, category = 'seascape',
          weight, length, width, height } = req.body || {};

  if (!isValidString(title) || !isValidString(medium) || typeof price !== 'number' || price < 0) {
    return res.status(400).json({ success: false, error: 'Invalid artwork data' });
  }

  const validCategories = ['seascape', 'figurative'];
  if (!validCategories.includes(category)) {
    return res.status(400).json({ success: false, error: 'Invalid category. Must be seascape or figurative.' });
  }

  // ── Shipping dimensions — required ────────────────────────────────────
  const dimFields = { weight, length, width, height };
  for (const [key, val] of Object.entries(dimFields)) {
    const num = parseFloat(val);
    if (isNaN(num) || num <= 0) {
      return res.status(400).json({ success: false, error: `Shipping ${key} is required and must be a positive number.` });
    }
  }

  // ── Length caps ───────────────────────────────────────────────────────
  const caps = capFields([
    ['Title',  title,  200],
    ['Medium', medium, 300],
  ]);
  if (!caps.ok) return res.status(400).json({ success: false, error: caps.error });

  // ── Image validation ──────────────────────────────────────────────────
  // Only validate if an image was actually provided — it's optional.
  if (imgData) {
    const imgCheck = validateImage(imgData);
    if (!imgCheck.ok) {
      await auditLog({
        action: 'image_rejected',
        ip:     getIp(req),
        detail: { endpoint: 'add-painting', reason: imgCheck.error },
      });
      return res.status(400).json({ success: false, error: imgCheck.error });
    }
  }

  try {
    const artworks = (await redis.get('artworks')) || [];
    const id = Date.now();
    artworks.push({
      id,
      category,
      title:   sanitizeString(title),
      medium:  sanitizeString(medium),
      price,
      sold:    Boolean(sold),
      imgData: imgData || null,
      svg:     null,
      shipping: {
        weight: parseFloat(weight),
        length: parseFloat(length),
        width:  parseFloat(width),
        height: parseFloat(height),
      },
    });
    await redis.set('artworks', artworks);

    await auditLog({
      action: 'add_painting',
      ip:     getIp(req),
      detail: { id, title: sanitizeString(title), price },
    });

    return res.status(200).json({ success: true, id });
  } catch (err) {
    console.error('add-painting error:', err);
    return res.status(500).json({ success: false });
  }
}
