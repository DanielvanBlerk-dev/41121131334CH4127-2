# Atelier — Fine Art Shop

A CSP-hardened static storefront with Square payment integration, built for Vercel.

## Project structure

```
atelier/
├── vercel.json          ← Vercel config + all HTTP security headers
└── public/
    ├── index.html       ← Clean HTML, zero inline JS, zero inline handlers
    ├── style.css        ← All styles
    ├── square-config.js ← Square credentials (swap sandbox → production here)
    └── script.js        ← All application logic
```

## Deploy to Vercel

```bash
npm i -g vercel      # install Vercel CLI (once)
cd atelier
vercel               # follow the prompts — done
```

Or push the folder to a GitHub repo and import it at vercel.com.

---

## Going live checklist

### 1 — Square credentials (`public/square-config.js`)
Replace both placeholder values:
```js
window.SQUARE_CONFIG = {
  applicationId: 'sq0idp-YOUR_REAL_APP_ID',   // Square Developer Dashboard → Applications
  locationId:    'YOUR_REAL_LOCATION_ID',      // Square Dashboard → Locations
};
```

### 2 — Square SDK URL (`public/index.html`)
Switch the `<script src>` from sandbox to production:
```html
<!-- Remove this: -->
<script src="https://sandbox.web.squarecdn.com/v1/square.js" defer></script>

<!-- Add this: -->
<script src="https://web.squarecdn.com/v1/square.js" defer></script>
```

### 3 — CSP URLs (`vercel.json`)
Update every sandbox URL to the production equivalent:
| Sandbox | Production |
|---|---|
| `https://sandbox.web.squarecdn.com` | `https://web.squarecdn.com` |
| `https://pci-connect.squareupsandbox.com` | `https://pci-connect.squareup.com` |
| `https://api.squareupsandbox.com` | `https://connect.squareup.com` |

### 4 — Backend payment endpoint (`public/script.js`)
Replace the `processPayment` stub with a real `fetch` to your server:
```js
async function processPayment(sourceId) {
  const res = await fetch('/api/pay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceId,
      items: cart.map(a => ({ id: a.id, title: a.title, price: a.price })),
      customer: {
        email:     document.getElementById('email').value,
        firstName: document.getElementById('first-name').value,
        lastName:  document.getElementById('last-name').value,
      },
      shipping: {
        address:  document.getElementById('address').value,
        city:     document.getElementById('city').value,
        state:    document.getElementById('state').value,
        postcode: document.getElementById('postcode').value,
        country:  document.getElementById('country').value,
      },
    }),
  });
  if (!res.ok) throw new Error('Payment failed');
  const { orderId } = await res.json();
  // mark sold, show success…
}
```
Your `/api/pay` endpoint must call Square's `POST /v2/payments` using your **secret key**,
which must never appear in any client-side file.

### 5 — Admin password (`public/script.js`)
Change `ADMIN_PASSWORD` to something strong before deploying:
```js
const ADMIN_PASSWORD = 'change-me-before-deploying';
```
For production, validate the password server-side and issue a short-lived token instead.

---

## Content Security Policy summary

| Directive | Allowed origins |
|---|---|
| `script-src` | `'self'` + Square CDN only |
| `style-src` | `'self'` + Google Fonts stylesheet |
| `font-src` | `'self'` + Google Fonts static files |
| `img-src` | `'self'` + `data:` + `blob:` |
| `connect-src` | `'self'` + Square API/PCI endpoints |
| `frame-src` | Square CDN + Square PCI iframe |
| `form-action` | `'self'` only |
| `frame-ancestors` | `'none'` (blocks clickjacking) |
| `X-Frame-Options` | `DENY` (redundant belt-and-braces) |

No `unsafe-inline`, no `unsafe-eval`, no wildcard sources anywhere.
