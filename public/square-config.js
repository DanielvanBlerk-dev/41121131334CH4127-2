/**
 * square-config.js
 * ─────────────────────────────────────────────────────────────────
 * Replace the two values below when going live:
 *   applicationId → from Square Developer Dashboard → Applications
 *   locationId    → from Square Dashboard → Locations
 *
 * Also update vercel.json Content-Security-Policy to switch from
 *   https://sandbox.web.squarecdn.com  →  https://web.squarecdn.com
 * and update the <script src> in index.html to the same production URL.
 * ─────────────────────────────────────────────────────────────────
 */
window.SQUARE_CONFIG = {
  applicationId: 'sandbox-sq0idb-REPLACE_WITH_YOUR_APP_ID',
  locationId:    'REPLACE_WITH_YOUR_LOCATION_ID',
};
