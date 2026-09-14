import { checkBodySize } from './_bodyLimit.js';
import { checkCsrf } from './_csrf.js';
import { getIp } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';
import { sendContactEmail, sendNewsletterSignupEmail } from './_sendEmail.js';
import { capFields } from './_sanitize.js';

/**
 * POST /api/contact
 * Public — no auth required.
 *
 * Handles two submission types, distinguished by the `type` field:
 *
 *   type: 'contact' (default, or omitted for backwards compatibility)
 *     Body: { name, email, message }
 *     Sends the contact form email.
 *
 *   type: 'newsletter'
 *     Body: { type: 'newsletter', name, email }
 *     No message required. Sends a mailing-list signup notification
 *     to the admin instead. Used by the new-visitor pop-up.
 *
 * Both types share this endpoint (rather than a separate serverless
 * function) to stay within Vercel's function-count limit on the Hobby
 * plan. Validates input, then sends an email to the admin via Resend.
 * Rate-limited server-side by IP to prevent spam — contact and
 * newsletter submissions are tracked with separate cooldowns so one
 * doesn't block the other from the same visitor.
 */

const CONTACT_COOLDOWN    = new Map(); // in-memory per-deploy rate limit — contact messages
const NEWSLETTER_COOLDOWN = new Map(); // in-memory per-deploy rate limit — newsletter signups
const COOLDOWN_MS = 60 * 1000;         // 1 submission per IP per minute, per type

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

  const { type = 'contact', name, email, message } = req.body || {};
  const isNewsletter = type === 'newsletter';

  // ── Simple in-memory rate limit (1 submission per IP per minute, per type) ─
  const cooldownMap = isNewsletter ? NEWSLETTER_COOLDOWN : CONTACT_COOLDOWN;
  const lastSent = cooldownMap.get(ip);
  if (lastSent && Date.now() - lastSent < COOLDOWN_MS) {
    const secsLeft = Math.ceil((COOLDOWN_MS - (Date.now() - lastSent)) / 1000);
    return res.status(429).json({
      error: `Please wait ${secsLeft} seconds before trying again.`,
    });
  }

  // ── Input validation ──────────────────────────────────────────────────
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Please enter your name.' });
  }
  if (!email || typeof email !== 'string' || !isValidEmail(email.trim())) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (hasHtml(name)) {
    return res.status(400).json({ error: 'Name contains invalid characters.' });
  }

  // Message is only required for the contact form, not the newsletter signup
  if (!isNewsletter) {
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Please enter a message.' });
    }
    if (hasHtml(message)) {
      return res.status(400).json({ error: 'Message contains invalid characters.' });
    }
  }

  // ── Length caps ───────────────────────────────────────────────────────
  const fieldsToCheck = [
    ['Name',  name.trim(),  100],
    ['Email', email.trim(), 254],
  ];
  if (!isNewsletter) {
    fieldsToCheck.push(['Message', message.trim(), 2000]);
  }
  const caps = capFields(fieldsToCheck);
  if (!caps.ok) return res.status(400).json({ error: caps.error });

  // ── Send email ────────────────────────────────────────────────────────
  try {
    const sent = isNewsletter
      ? await sendNewsletterSignupEmail({ name: name.trim(), email: email.trim() })
      : await sendContactEmail({ name: name.trim(), email: email.trim(), message: message.trim() });

    // Record the send time for rate limiting regardless of email outcome
    cooldownMap.set(ip, Date.now());
    await auditLog({
      action: isNewsletter ? 'newsletter_signup' : 'contact_message_sent',
      ip,
      detail: { name: name.trim(), emailSent: sent },
    });

    if (!sent) {
      // Email failed (Resend not configured or domain not verified)
      // Return a helpful fallback rather than an error — not the user's fault
      return res.status(200).json({
        success:  false,
        fallback: true,
        error: isNewsletter
          ? 'Sign-up could not be completed right now. Please try again later.'
          : 'The contact form is not yet active. Please email Michael directly at michael.p.vanblerk@gmail.com',
      });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('contact error:', err);
    return res.status(500).json({
      error: isNewsletter
        ? 'Sign-up could not be completed. Please try again later.'
        : 'Message could not be sent. Please email Michael directly at michael.p.vanblerk@gmail.com',
    });
  }
}
