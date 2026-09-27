# Airlie Beach Art

The e-commerce site and admin backend for Michael van Blerk's original paintings and print
sales, built as Vercel serverless functions behind a vanilla HTML/CSS/JS storefront — no
frontend framework or build step.

## Stack

| Layer | What it does |
|---|---|
| **Frontend** | Plain HTML/CSS/JS in `public/` — gallery, cart, checkout, lightbox, admin panel. No inline JS/handlers, no build step. |
| **Backend** | Vercel serverless functions in `api/` (Node, ES modules). |
| **Data store** | Upstash Redis — artworks, orders, and admin-configurable settings. |
| **Photo storage** | Vercel Blob — every uploaded photo is stored as two files: a full-size version (lightbox + print orders) and a small thumbnail (gallery grid), generated at upload time by an admin-configurable compression pipeline (`sharp`). |
| **Payments** | Square Web Payments SDK (client-side tokenization) + Square Payments API (server-side charge). |
| **Print fulfilment** | Gelato print-on-demand API — product catalogue import, shipping quotes, and order submission for "Gelato print" listings. |
| **Shipping quotes** | Australia Post API, for Original / Oversized / Original Print listings (Gelato quotes its own shipping for its own listings). |
| **Email** | Resend — purchase notifications, contact form submissions, newsletter sign-ups. |
| **Admin auth** | Password checked against a bcrypt hash, a signed JWT session token issued and sent back as a Bearer header on every admin request. |

## Project structure

```
airlie-beach-art/
├── package.json
├── api/                          ← Vercel serverless functions
│   ├── login.js / logout.js      ← Admin sign-in/out
│   ├── paintings.js              ← Create/update/delete/reorder listings, Gelato product
│   │                                import, image-compression settings, thumbnail backfill
│   ├── upload-image.js           ← Photo upload (produces full image + thumbnail)
│   ├── update-artist-photo.js    ← About-page artist photo
│   ├── get-artworks.js           ← Public gallery data
│   ├── get-orders.js             ← Admin orders panel data
│   ├── create-payment.js         ← Square charge, stock/sold updates, Gelato order
│   │                                submission, purchase-confirmation email
│   ├── postage.js                ← AusPost + Gelato shipping quotes
│   ├── contact.js                ← Contact form + newsletter sign-up
│   ├── _verifyAdmin.js           ← Admin token verification (shared by admin-only routes)
│   ├── _csrf.js                  ← CSRF token check (shared)
│   ├── _rateLimit.js             ← IP-based rate limiting (shared)
│   ├── _bodyLimit.js             ← Request body size limits (shared)
│   ├── _sanitize.js              ← Input sanitisation/length caps (shared)
│   ├── _auditLog.js              ← Admin-action audit log (shared)
│   ├── _imageSettings.js         ← Admin-configurable compression settings (Redis-backed)
│   ├── _imageCompress.js         ← Resize/compress pipeline (full image + thumbnail)
│   └── _sendEmail.js             ← Resend wrapper (purchase/contact/newsletter emails)
└── public/
    ├── index.html
    ├── style.css
    ├── square-config.js          ← Square Application ID + Location ID (public values, not secret)
    └── script.js                 ← Gallery, cart, checkout, lightbox, and admin panel logic
```

## Listing types

A listing's `source` (and `oversized`) field decides how it's shipped and sold:

| Type | Shipping | Stock behaviour |
|---|---|---|
| **Original** | Australia Post, using the listing's packed weight/dimensions | One-of-a-kind — sold manually by the admin |
| **Oversized** | Freight — shows a "Contact Artist" link instead of Add to Cart | One-of-a-kind |
| **Gelato print** | Quoted and fulfilled by Gelato print-on-demand | Unlimited — never auto-marked sold by a purchase |
| **Original Print** | Australia Post, like a standard Original | Fixed run size (`stockLimit`); `stockSold` increments on each sale and the listing auto-flips to sold once the run is exhausted |

**Multi-size listings:** Gelato print and Original Print listings can be offered in more than
one size, each size saved as its own listing (own price, stock, and photos) sharing a
`printGroupId`. The gallery combines every listing with the same `printGroupId` into one card
with a size picker, showing whichever size's price/stock/photos are currently selected.

## Image pipeline

Every photo uploaded through the admin panel (manual upload or a Gelato preview import) is
resized and re-encoded into two files — a full-size version and a small thumbnail — using
settings the admin controls from the Image Settings panel (`_imageSettings.js`,
`_imageCompress.js`). The gallery grid serves the thumbnail; the lightbox and Gelato print
orders always use the full-size version. This keeps Vercel Blob "Data Transfer" usage down,
since the grid never needs to serve a full-resolution photo just to render a few-hundred-pixel
tile.

Photos uploaded before this system existed have no thumbnail yet — the Image Settings panel's
"Regenerate thumbnails for existing photos" button backfills them retroactively, in small
batches, until the whole catalogue is covered.

## Security

- **Admin auth** — bcrypt-hashed password, JWT session token sent as a Bearer header on every
  admin request (`_verifyAdmin.js`).
- **CSRF protection** on every state-changing request (`_csrf.js`).
- **Rate limiting** by IP, including login attempts (`_rateLimit.js`).
- **Request body size limits** to block oversized payloads before they're parsed (`_bodyLimit.js`).
- **Input sanitisation and length caps** on all text fields (`_sanitize.js`).
- **Audit log** of every admin action — add/edit/delete a listing, toggle sold, reorder,
  change settings, log in — written to Redis (`_auditLog.js`).
- **Server-side price recomputation** at payment time (`create-payment.js` re-derives the
  expected charge from the cart's actual listings rather than trusting the client), and a
  same-server re-check that a listing hasn't sold out or its stock changed since the cart was
  built.
- **Content Security Policy** — see `vercel.json`. `img-src` needs to allow your Vercel Blob
  storage domain (photos are served from `*.public.blob.vercel-storage.com`, not `'self'`)
  alongside the existing Square/Google Fonts entries; keep this in sync if the CSP is edited.

## Environment variables

None of these are set in this repo — configure them in the Vercel project's Environment
Variables settings (or `vercel env add` locally). Names only, no values, are listed here:

| Variable | Used for |
|---|---|
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Redis data store |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob photo storage |
| `SQUARE_ACCESS_TOKEN` / `SQUARE_LOCATION_ID` | Server-side Square payment charges |
| `GELATO_API_KEY` / `GELATO_STORE_ID` | Gelato product catalogue, shipping quotes, order submission |
| `AUSPOST_API_KEY` | Australia Post shipping quotes |
| `RESEND_API_KEY` | Transactional email (purchase, contact, newsletter) |
| `ADMIN_EMAIL` | Recipient for purchase/contact/newsletter notifications |
| *(admin password hash / JWT signing secret)* | Set whatever `_verifyAdmin.js` and `login.js` read — check those files for the exact names before deploying |

`public/square-config.js` holds the **client-side** Square Application ID and Location ID —
these are meant to be public (Square's own docs treat them as non-secret) and are separate from
the server-side `SQUARE_ACCESS_TOKEN` above, which must never appear in any file served to the
browser.

## Deploy to Vercel

```bash
npm i -g vercel      # install Vercel CLI (once)
cd airlie-beach-art
vercel               # follow the prompts — done
```

Or push the repo to GitHub and import it at vercel.com. Set every environment variable above in
the Vercel dashboard before the first real deploy — the app degrades gracefully for a missing
Gelato/AusPost key (that feature just reports unavailable), but Redis, Blob, and Square
credentials are required for the site to function at all.

### Square: sandbox → production

1. **`public/square-config.js`** — replace the Application ID and Location ID with your
   production values from the Square Developer Dashboard.
2. **`public/index.html`** — switch the Square SDK `<script src>` from
   `sandbox.web.squarecdn.com` to `web.squarecdn.com`.
3. **`vercel.json`** — update every `squareupsandbox.com` / `sandbox.web.squarecdn.com` CSP
   entry to its production equivalent (`squareup.com` / `web.squarecdn.com`).
4. **`SQUARE_ACCESS_TOKEN`** — set to your production secret key in Vercel's environment
   variables, not sandbox.
