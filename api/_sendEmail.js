/**
 * _sendEmail.js — Email helper using Resend
 *
 * Required Vercel env vars:
 *   RESEND_API_KEY  — from resend.com → API Keys
 *   ADMIN_EMAIL     — where purchase notifications are sent
 *
 * Domain verification:
 *   Verify airliebeachart.com in Resend → Domains to send
 *   from noreply@airliebeachart.com. Until verified, Resend
 *   will use their onboarding domain as the sender.
 */

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * Sends an email via Resend.
 *
 * @param {object} opts
 * @param {string}   opts.to      - recipient address
 * @param {string}   opts.subject - email subject
 * @param {string}   opts.html    - email body HTML
 * @returns {Promise<boolean>}    - true on success, false on failure
 */
export async function sendEmail({ to, subject, html }) {
  const apiKey     = process.env.RESEND_API_KEY;
  const adminEmail = process.env.ADMIN_EMAIL || 'michael.p.vanblerk@gmail.com';

  if (!apiKey) {
    console.error('RESEND_API_KEY not set — email not sent');
    return false;
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    `Airlie Beach Art <noreply@airliebeachart.com>`,
        to:      [to],
        subject,
        html,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Resend error:', res.status, err);
      return false;
    }

    return true;
  } catch (err) {
    console.error('sendEmail error:', err);
    return false;
  }
}

/**
 * Builds and sends a purchase notification to the admin.
 *
 * @param {object} opts
 * @param {string}   opts.orderId
 * @param {Array}    opts.items        - cart items [{ id, title, price }]
 * @param {number}   opts.artworkTotal - total artwork cost in AUD
 * @param {string}   opts.postageName
 * @param {number}   opts.postagePrice - postage cost in AUD
 * @param {number}   opts.grandTotal   - total charge in AUD
 * @param {object}   opts.customer     - { firstName, lastName, email, phone }
 * @param {object}   opts.shipping     - { address, city, state, postcode, country }
 */
export async function sendPurchaseNotification({
  orderId,
  items,
  artworkTotal,
  postageName,
  postagePrice,
  grandTotal,
  customer,
  shipping,
}) {
  const adminEmail = process.env.ADMIN_EMAIL || 'michael.p.vanblerk@gmail.com';

  const itemRows = items.map(i => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #ede9e1;font-family:Georgia,serif;font-style:italic;">${i.title}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #ede9e1;text-align:right;">AUD $${i.price.toLocaleString()}</td>
    </tr>
  `).join('');

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f9f6f1;font-family:'Courier New',monospace;font-size:13px;color:#1a1612;">
  <div style="max-width:580px;margin:40px auto;background:#fff;border:1px solid rgba(26,22,18,0.12);">

    <!-- Header -->
    <div style="background:#1a1612;padding:24px 32px;">
      <p style="margin:0;font-family:Georgia,serif;font-size:22px;font-weight:300;color:#f9f6f1;letter-spacing:0.1em;text-transform:uppercase;">
        Airlie Beach Art
      </p>
      <p style="margin:6px 0 0;font-size:11px;color:#b8965a;letter-spacing:0.15em;text-transform:uppercase;">
        New Purchase — Order ${orderId}
      </p>
    </div>

    <div style="padding:32px;">

      <!-- Order summary -->
      <p style="margin:0 0 16px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#b8965a;border-bottom:1px solid #ede9e1;padding-bottom:8px;">
        Works Sold
      </p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        ${itemRows}
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #ede9e1;color:#7a7368;">${postageName}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #ede9e1;text-align:right;color:#7a7368;">AUD $${postagePrice.toFixed(2)}</td>
        </tr>
        <tr style="background:#f9f6f1;">
          <td style="padding:10px 12px;font-family:Georgia,serif;font-size:16px;"><strong>Total Charged</strong></td>
          <td style="padding:10px 12px;text-align:right;font-family:Georgia,serif;font-size:16px;color:#b8965a;"><strong>AUD $${grandTotal.toFixed(2)}</strong></td>
        </tr>
      </table>

      <!-- Customer details -->
      <p style="margin:0 0 16px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#b8965a;border-bottom:1px solid #ede9e1;padding-bottom:8px;">
        Customer
      </p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tr>
          <td style="padding:6px 12px;width:120px;color:#7a7368;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">Name</td>
          <td style="padding:6px 12px;">${customer.firstName} ${customer.lastName}</td>
        </tr>
        <tr style="background:#f9f6f1;">
          <td style="padding:6px 12px;color:#7a7368;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">Email</td>
          <td style="padding:6px 12px;"><a href="mailto:${customer.email}" style="color:#1a1612;">${customer.email}</a></td>
        </tr>
        <tr>
          <td style="padding:6px 12px;color:#7a7368;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">Phone</td>
          <td style="padding:6px 12px;">${customer.phone || '—'}</td>
        </tr>
      </table>

      <!-- Shipping address -->
      <p style="margin:0 0 16px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#b8965a;border-bottom:1px solid #ede9e1;padding-bottom:8px;">
        Ship To
      </p>
      <div style="padding:12px;background:#f9f6f1;border:1px solid #ede9e1;margin-bottom:24px;line-height:1.8;">
        ${shipping.address}<br>
        ${shipping.city} ${shipping.state} ${shipping.postcode}<br>
        ${shipping.country}
      </div>

      <!-- Payment confirmed -->
      <div style="background:#f0f7f0;border:1px solid #c8dfc8;padding:12px 16px;margin-bottom:24px;">
        <p style="margin:0;font-size:12px;color:#2d5a27;">
          &#10003; Payment confirmed by Square. Order ID: <strong>${orderId}</strong>
        </p>
      </div>

      <p style="margin:0;font-size:11px;color:#7a7368;line-height:1.7;">
        This is an automated notification from your Airlie Beach Art store.
        Reply directly to the customer at
        <a href="mailto:${customer.email}" style="color:#b8965a;">${customer.email}</a>
        to arrange dispatch.
      </p>

    </div><!-- /padding -->
  </div><!-- /container -->
</body>
</html>`;

  return sendEmail({
    to:      adminEmail,
    subject: `New sale — ${items.map(i => i.title).join(', ')} · AUD $${grandTotal.toFixed(2)}`,
    html,
  });
}

/**
 * Sends a contact form message to the admin.
 *
 * @param {object} opts
 * @param {string} opts.name    - sender's name
 * @param {string} opts.email   - sender's email
 * @param {string} opts.message - message body
 */
export async function sendContactEmail({ name, email, message }) {
  const adminEmail = process.env.ADMIN_EMAIL || 'michael.p.vanblerk@gmail.com';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9f6f1;font-family:'Courier New',monospace;font-size:13px;color:#1a1612;">
  <div style="max-width:580px;margin:40px auto;background:#fff;border:1px solid rgba(26,22,18,0.12);">

    <div style="background:#1a1612;padding:24px 32px;">
      <p style="margin:0;font-family:Georgia,serif;font-size:22px;font-weight:300;color:#f9f6f1;letter-spacing:0.1em;text-transform:uppercase;">
        Airlie Beach Art
      </p>
      <p style="margin:6px 0 0;font-size:11px;color:#b8965a;letter-spacing:0.15em;text-transform:uppercase;">
        New message from your website
      </p>
    </div>

    <div style="padding:32px;">

      <p style="margin:0 0 16px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#b8965a;border-bottom:1px solid #ede9e1;padding-bottom:8px;">
        From
      </p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tr>
          <td style="padding:6px 12px;width:80px;color:#7a7368;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">Name</td>
          <td style="padding:6px 12px;">${name}</td>
        </tr>
        <tr style="background:#f9f6f1;">
          <td style="padding:6px 12px;color:#7a7368;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">Email</td>
          <td style="padding:6px 12px;"><a href="mailto:${email}" style="color:#1a1612;">${email}</a></td>
        </tr>
      </table>

      <p style="margin:0 0 16px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#b8965a;border-bottom:1px solid #ede9e1;padding-bottom:8px;">
        Message
      </p>
      <div style="padding:16px;background:#f9f6f1;border:1px solid #ede9e1;line-height:1.8;white-space:pre-wrap;">${message}</div>

      <p style="margin:24px 0 0;font-size:11px;color:#7a7368;line-height:1.7;">
        Reply directly to
        <a href="mailto:${email}" style="color:#b8965a;">${email}</a>
        to respond to this message.
      </p>

    </div>
  </div>
</body>
</html>`;

  return sendEmail({
    to:      adminEmail,
    subject: `New message from ${name} — Airlie Beach Art`,
    html,
  });
}
