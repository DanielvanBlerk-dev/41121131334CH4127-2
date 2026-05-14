import { checkBodySize } from './_bodyLimit.js';
import { checkCsrf } from './_csrf.js';
import { getIp } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';
import { sendContactEmail } from './_sendEmail.js';
import { capFields } from './_sanitize.js';

/**
 * POST /api/contact
 * Public — no auth required.
 * Body: { name, email, message }
 *
 * Validates input, then sends an email to the admin via Resend.
 * Rate-limited server-side by IP to prevent spam.
 */

const CONTACT_COOLDOWN = new Map(); // in-memory per-deploy rate limit
const COOLDOWN_MS = 60 * 1000;     // 1 message per IP per minute

function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}
function hasHtml(str) {
  return /[<>]/.test(str);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = getIp(req);

  // ── Body size limit ───────────────────────────────────────────────────
  const size = checkBodySize(req, '5kb');
  if (!size.ok) return res.status(413).json({ error: size.error });

  // ── CSRF check ────────────────────────────────────────────────────────
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    await auditLog({ action: 'csrf_rejected', ip, detail: { endpoint: 'contact', reason: csrf.reason } });
    return res.status(403).json({ error: 'Forbidden' });
  }

  // ── Simple in-memory rate limit (1 message per IP per minute) ─────────
  const lastSent = CONTACT_COOLDOWN.get(ip);
  if (lastSent && Date.now() - lastSent < COOLDOWN_MS) {
    const secsLeft = Math.ceil((COOLDOWN_MS - (Date.now() - lastSent)) / 1000);
    return res.status(429).json({
      error: `Please wait ${secsLeft} seconds before sending another message.`,
    });
  }

  // ── Input validation ──────────────────────────────────────────────────
  const { name, email, message } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Please enter your name.' });
  }
  if (!email || typeof email !== 'string' || !isValidEmail(email.trim())) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Please enter a message.' });
  }
  if (hasHtml(name) || hasHtml(message)) {
    return res.status(400).json({ error: 'Message contains invalid characters.' });
  }

  // ── Length caps ───────────────────────────────────────────────────────
  const caps = capFields([
    ['Name',    name.trim(),    100],
    ['Email',   email.trim(),   254],
    ['Message', message.trim(), 2000],
  ]);
  if (!caps.ok) return res.status(400).json({ error: caps.error });

  // ── Send email ────────────────────────────────────────────────────────
  try {
    const sent = await sendContactEmail({
      name:    name.trim(),
      email:   email.trim(),
      message: message.trim(),
    });

    // Record the send time for rate limiting regardless of email outcome
    CONTACT_COOLDOWN.set(ip, Date.now());
    await auditLog({ action: 'contact_message_sent', ip, detail: { name: name.trim(), emailSent: sent } });

    if (!sent) {
      // Email failed (Resend not configured or domain not verified)
      // Return a helpful fallback rather than an error — not the user's fault
      return res.status(200).json({
        success:  false,
        fallback: true,
        error:    'The contact form is not yet active. Please email Michael directly at michael.p.vanblerk@gmail.com',
      });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('contact error:', err);
    return res.status(500).json({
      error: 'Message could not be sent. Please email Michael directly at michael.p.vanblerk@gmail.com',
    });
  }
}
