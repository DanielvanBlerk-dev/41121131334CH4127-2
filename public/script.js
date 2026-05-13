'use strict';

/* ─── SESSION ─────────────────────────────────────────────────────────────── */
// Admin JWT is stored only in sessionStorage — cleared when the tab closes.
const SESSION_KEY = 'atelier_admin_token';

function getToken()        { try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; } }
function setToken(t)       { try { sessionStorage.setItem(SESSION_KEY, t); }    catch {} }
function clearToken()      { try { sessionStorage.removeItem(SESSION_KEY); }    catch {} }
function isLoggedIn()      { return !!getToken(); }

/* ─── STATE ───────────────────────────────────────────────────────────────── */
let artworks        = [];
let cart            = [];
let isAdmin         = false;
let pendingDeleteId = null;
let newImgData      = null;
let squareCard      = null;
let squarePayments  = null;

/* ─── API HELPERS ─────────────────────────────────────────────────────────── */
async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type':    'application/json',
    'X-Requested-With': 'XMLHttpRequest',  // CSRF protection — required by all mutating endpoints
    ...(options.headers || {}),
  };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error || 'Request failed'), { status: res.status });
  }
  return res.json();
}

/* ─── GALLERY — load from API ─────────────────────────────────────────────── */
async function loadArtworks() {
  try {
    const data = await apiFetch('/api/get-artworks');
    artworks = data.artworks || [];
  } catch (e) {
    console.error('Failed to load artworks:', e);
    artworks = [];
  }
}

/* ─── GALLERY — render ────────────────────────────────────────────────────── */
function renderGallery() {
  const grid     = el('gallery-grid');
  const fragment = document.createDocumentFragment();

  artworks.forEach(art => {
    const card = document.createElement('div');
    card.className = 'artwork-card';
    card.id = 'card-' + art.id;

    // Image area
    const imgWrap = document.createElement('div');
    imgWrap.className = 'artwork-img';
    if (art.imgData) {
      const img = document.createElement('img');
      img.src = art.imgData; img.alt = art.title;
      imgWrap.appendChild(img);
    } else if (art.svg) {
      imgWrap.innerHTML = art.svg;
    }
    if (art.sold) {
      const overlay = document.createElement('div');
      overlay.className = 'sold-overlay';
      overlay.textContent = 'Sold';
      imgWrap.appendChild(overlay);
    }

    // Label row
    const labelRow  = document.createElement('div'); labelRow.className = 'artwork-label';
    const titleEl   = document.createElement('span'); titleEl.className  = 'artwork-title'; titleEl.textContent = art.title;
    const priceEl   = document.createElement('span'); priceEl.className  = 'artwork-price'; priceEl.textContent = 'AUD $' + art.price.toLocaleString();
    labelRow.appendChild(titleEl); labelRow.appendChild(priceEl);

    const mediumEl  = document.createElement('div'); mediumEl.className = 'artwork-medium'; mediumEl.textContent = art.medium;

    // Add to cart button
    const addBtn = document.createElement('button');
    addBtn.className = 'add-btn' + (inCart(art.id) ? ' added' : '');
    addBtn.disabled  = art.sold || inCart(art.id);
    addBtn.textContent = art.sold ? 'Sold' : inCart(art.id) ? 'In your selection' : '+ Add to selection';
    addBtn.addEventListener('click', () => addToCart(art.id));

    // Admin controls
    const adminCtrl = document.createElement('div');
    adminCtrl.className = 'admin-controls' + (isAdmin ? ' visible' : '');

    const soldBtn = document.createElement('button');
    soldBtn.className  = 'admin-ctrl-btn sold-toggle';
    soldBtn.textContent = art.sold ? 'Mark available' : 'Mark sold';
    soldBtn.addEventListener('click', () => toggleSold(art.id));

    const delBtn = document.createElement('button');
    delBtn.className  = 'admin-ctrl-btn del';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => confirmDelete(art.id, art.title));

    adminCtrl.appendChild(soldBtn);
    adminCtrl.appendChild(delBtn);

    card.appendChild(imgWrap); card.appendChild(labelRow); card.appendChild(mediumEl);
    card.appendChild(addBtn);  card.appendChild(adminCtrl);
    fragment.appendChild(card);
  });

  grid.innerHTML = '';
  grid.appendChild(fragment);
}

function inCart(id) { return cart.some(i => i.id === id); }

/* ─── ADMIN AUTH ──────────────────────────────────────────────────────────── */
function openLogin() {
  el('admin-pw').value = '';
  el('login-error').textContent = '';
  el('login-overlay').classList.add('open');
  setTimeout(() => el('admin-pw').focus(), 200);
}
function closeLogin() { el('login-overlay').classList.remove('open'); }

async function attemptLogin() {
  const pw    = el('admin-pw').value;
  const btnEl = el('login-btn');

  if (!pw) { el('login-error').textContent = 'Please enter your password.'; return; }

  btnEl.disabled    = true;
  btnEl.textContent = 'Signing in…';

  try {
    const data = await apiFetch('/api/login', {
      method: 'POST',
      body:   JSON.stringify({ password: pw }),
    });
    setToken(data.token);
    isAdmin = true;
    closeLogin();
    activateAdminMode();
  } catch (e) {
    el('login-error').textContent = e.status === 401 ? 'Incorrect password.' : 'Login failed. Please try again.';
    el('admin-pw').value = '';
    el('admin-pw').focus();
  } finally {
    btnEl.disabled    = false;
    btnEl.textContent = 'Sign in';
  }
}

function adminLogout() {
  clearToken();
  isAdmin = false;
  el('admin-bar').classList.remove('visible');
  el('admin-nav-link').classList.remove('active');
  renderGallery();
}

function activateAdminMode() {
  isAdmin = true;
  el('admin-bar').classList.add('visible');
  el('admin-nav-link').classList.add('active');
  renderGallery();
}

/* ─── ADMIN ACTIONS ───────────────────────────────────────────────────────── */
async function toggleSold(id) {
  try {
    await apiFetch('/api/toggle-sold', {
      method: 'PATCH',
      body:   JSON.stringify({ id }),
    });
    await loadArtworks();
    renderGallery();
    updateCartUI();
  } catch (e) {
    console.error('toggleSold failed:', e);
    alert('Could not update status. Please try again.');
  }
}

function confirmDelete(id, title) {
  pendingDeleteId = id;
  el('confirm-sub').textContent = '"' + title + '" will be removed from your gallery permanently.';
  el('confirm-overlay').classList.add('open');
}
function closeConfirm() { el('confirm-overlay').classList.remove('open'); }

async function executeDeletion() {
  if (!pendingDeleteId) return;
  const id = pendingDeleteId;
  pendingDeleteId = null;
  el('confirm-overlay').classList.remove('open');

  try {
    await apiFetch('/api/delete-painting', {
      method: 'DELETE',
      body:   JSON.stringify({ id }),
    });
    cart = cart.filter(i => i.id !== id);
    await loadArtworks();
    renderGallery();
    updateCartUI();
  } catch (e) {
    console.error('delete failed:', e);
    alert('Could not delete painting. Please try again.');
  }
}

/* ─── ADD PAINTING ────────────────────────────────────────────────────────── */
function openAddPanel() {
  el('add-panel').classList.add('open');
  document.body.style.overflow = 'hidden';
  ['new-title', 'new-medium', 'new-price'].forEach(id => el(id).value = '');
  el('new-sold').checked = false;
  el('add-error').textContent = '';
  el('img-placeholder').style.display = 'block';
  el('img-preview-el').style.display  = 'none';
  newImgData = null;
}
function closeAddPanel() {
  el('add-panel').classList.remove('open');
  document.body.style.overflow = '';
}

function handleImgUpload(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    newImgData = ev.target.result;
    el('img-placeholder').style.display = 'none';
    const preview = el('img-preview-el');
    preview.src = newImgData; preview.style.display = 'block';
  };
  reader.readAsDataURL(file);
}

async function saveNewPainting() {
  const title    = el('new-title').value.trim();
  const medium   = el('new-medium').value.trim();
  const priceRaw = el('new-price').value;
  const sold     = el('new-sold').checked;
  const errEl    = el('add-error');

  if (!title)  { errEl.textContent = 'Please enter a title.'; return; }
  if (!medium) { errEl.textContent = 'Please enter the medium and dimensions.'; return; }
  const price = parseInt(priceRaw, 10);
  if (!priceRaw || isNaN(price) || price < 0) { errEl.textContent = 'Please enter a valid price.'; return; }

  const btn = el('save-painting-btn');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const data = await apiFetch('/api/add-painting', {
      method: 'POST',
      body:   JSON.stringify({ title, medium, price, sold, imgData: newImgData || null }),
    });
    await loadArtworks();
    renderGallery();
    closeAddPanel();
    setTimeout(() => {
      const card = document.getElementById('card-' + data.id);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
  } catch (e) {
    errEl.textContent = 'Failed to save painting. Please try again.';
    console.error(e);
  } finally {
    btn.disabled = false; btn.textContent = 'Save painting to gallery';
  }
}

/* ─── CART ────────────────────────────────────────────────────────────────── */
function addToCart(id) {
  const art = artworks.find(a => a.id === id);
  if (!art || art.sold || inCart(id)) return;
  cart.push(art);
  updateCartUI(); renderGallery(); openCart();
}
function removeFromCart(id) {
  cart = cart.filter(i => i.id !== id);
  updateCartUI(); renderGallery();
}

function updateCartUI() {
  const count = cart.length;
  el('cart-count').textContent  = count;
  el('checkout-btn').disabled   = count === 0;
  const total = cart.reduce((s, i) => s + i.price, 0);
  el('cart-total').textContent  = 'AUD $' + total.toLocaleString();

  const itemsEl = el('cart-items');
  const emptyEl = el('cart-empty');

  if (count === 0) {
    itemsEl.innerHTML = '';
    itemsEl.appendChild(emptyEl);
    emptyEl.style.display = 'block';
    return;
  }

  emptyEl.style.display = 'none';
  const frag = document.createDocumentFragment();
  frag.appendChild(emptyEl);

  cart.forEach(art => {
    const item   = document.createElement('div'); item.className = 'cart-item';
    const thumb  = document.createElement('div'); thumb.className = 'cart-item-thumb';

    if (art.imgData) {
      const img = document.createElement('img'); img.src = art.imgData; img.alt = art.title;
      thumb.appendChild(img);
    } else if (art.svg) { thumb.innerHTML = art.svg; }

    const info      = document.createElement('div');
    const nameEl    = document.createElement('div'); nameEl.className = 'cart-item-name'; nameEl.textContent = art.title;
    const metaEl    = document.createElement('div'); metaEl.className = 'cart-item-meta'; metaEl.textContent = art.medium;
    const removeBtn = document.createElement('button'); removeBtn.className = 'remove-item'; removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => removeFromCart(art.id));
    info.appendChild(nameEl); info.appendChild(metaEl); info.appendChild(removeBtn);

    const priceEl = document.createElement('div'); priceEl.className = 'cart-item-price';
    priceEl.textContent = '$' + art.price.toLocaleString();

    item.appendChild(thumb); item.appendChild(info); item.appendChild(priceEl);
    frag.appendChild(item);
  });

  itemsEl.innerHTML = '';
  itemsEl.appendChild(frag);
}

function openCart() {
  el('cart-overlay').classList.add('open');
  el('cart-panel').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeCart() {
  el('cart-overlay').classList.remove('open');
  el('cart-panel').classList.remove('open');
  document.body.style.overflow = '';
}
function toggleCart() {
  if (el('cart-panel').classList.contains('open')) closeCart(); else openCart();
}

/* ─── CHECKOUT ────────────────────────────────────────────────────────────── */
function buildOrderSummary() {
  const total     = cart.reduce((s, i) => s + i.price, 0);
  const summaryEl = el('order-summary');
  summaryEl.innerHTML = '';
  cart.forEach(a => {
    const row       = document.createElement('div'); row.className = 'order-line';
    const nameSpan  = document.createElement('span');
    const em        = document.createElement('em'); em.textContent = a.title;
    nameSpan.appendChild(em);
    const priceSpan = document.createElement('span'); priceSpan.textContent = 'AUD $' + a.price.toLocaleString();
    row.appendChild(nameSpan); row.appendChild(priceSpan);
    summaryEl.appendChild(row);
  });
  const totalRow = document.createElement('div'); totalRow.className = 'order-line total';
  totalRow.innerHTML = '<strong>Total</strong><strong>AUD $' + total.toLocaleString() + '</strong>';
  summaryEl.appendChild(totalRow);
}

async function openCheckout() {
  closeCart();
  document.body.style.overflow = 'hidden';
  buildOrderSummary();
  el('checkout-modal').classList.add('open');
  el('checkout-body').style.display = 'block';
  el('success-state').style.display = 'none';
  if (!squareCard) await initSquare();
}
function closeCheckout() {
  el('checkout-modal').classList.remove('open');
  document.body.style.overflow = '';
}

/* ─── SQUARE ──────────────────────────────────────────────────────────────── */
async function initSquare() {
  if (!window.Square) { showPaymentError('Square failed to load. Check your connection.'); return; }
  try {
    const cfg      = window.SQUARE_CONFIG;
    squarePayments = window.Square.payments(cfg.applicationId, cfg.locationId);
    squareCard     = await squarePayments.card();
    await squareCard.attach('#card-container');
  } catch (e) {
    console.error('Square init error:', e);
    el('card-container').textContent = '⚠️ Payment form could not load. Check your Square credentials in square-config.js.';
  }
}

function showPaymentError(msg) {
  const errEl = el('payment-error');
  errEl.textContent  = msg;
  errEl.style.display = 'block';
}

/* ─── FORM FIELD HELPERS ──────────────────────────────────────────────────── */
function fieldVal(id)        { return el(id).value.trim(); }
function hasHtml(str)        { return /[<>]/.test(str); }
function validPhone(str)     { return /^[0-9+\s\-]{6,20}$/.test(str); }
function validPostcode(str)  { return /^[0-9]{4,10}$/.test(str); }
function validEmail(str)     { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str); }

/**
 * Validates and returns sanitised form values, or null on failure.
 * Call before tokenising with Square AND again before sending to the API.
 */
function validateForm() {
  // Trim + HTML-tag check on all text fields
  const textFields = [
    ['first-name', 'First name'],
    ['last-name',  'Last name'],
    ['address',    'Street address'],
    ['city',       'City'],
    ['state',      'State'],
    ['country',    'Country'],
  ];

  for (const [id, label] of textFields) {
    const val = fieldVal(id);
    if (!val) {
      showPaymentError('Please enter your ' + label + '.'); return null;
    }
    if (hasHtml(val)) {
      showPaymentError(label + ' must not contain HTML characters.'); return null;
    }
  }

  // Email
  const email = fieldVal('email');
  if (!email) {
    showPaymentError('Please enter your email address.'); return null;
  }
  if (hasHtml(email) || !validEmail(email)) {
    showPaymentError('Please enter a valid email address.'); return null;
  }

  // Phone — optional but validated if provided
  const phone = fieldVal('phone');
  if (phone && !validPhone(phone)) {
    showPaymentError('Please enter a valid phone number (digits, spaces, + and - only).'); return null;
  }

  // Postcode — numeric only
  const postcode = fieldVal('postcode');
  if (!postcode) {
    showPaymentError('Please enter your postcode.'); return null;
  }
  if (!validPostcode(postcode)) {
    showPaymentError('Postcode must be numeric only.'); return null;
  }

  // Return all trimmed values so processPayment doesn't re-read the DOM
  return {
    firstName: fieldVal('first-name'),
    lastName:  fieldVal('last-name'),
    email,
    phone,
    address:   fieldVal('address'),
    city:      fieldVal('city'),
    state:     fieldVal('state'),
    postcode,
    country:   fieldVal('country'),
  };
}

async function handlePayment() {
  el('payment-error').style.display = 'none';

  const fields = validateForm();
  if (!fields) return;

  if (!squareCard) { showPaymentError('Payment form is not ready. Please try again.'); return; }

  const btn = el('pay-btn');
  btn.disabled = true; btn.textContent = 'Processing…';

  try {
    const result = await squareCard.tokenize();
    if (result.status === 'OK') {
      await processPayment(result.token, fields);
    } else {
      const code = result.errors?.[0]?.code || '';
      showPaymentError(safeCardError(code));
      await squareCard.clear?.();
      btn.disabled = false; btn.textContent = 'Complete Purchase';
    }
  } catch (e) {
    showPaymentError('An unexpected error occurred. Please try again.');
    btn.disabled = false; btn.textContent = 'Complete Purchase';
  }
}

async function processPayment(sourceId, fields) {
  const recheck = validateForm();
  if (!recheck) {
    const btn = el('pay-btn');
    btn.disabled = false; btn.textContent = 'Complete Purchase';
    return;
  }

  try {
    // Send item IDs only — server computes prices from Redis.
    // Never send client-computed amounts; the server ignores them anyway.
    const data = await apiFetch('/api/create-payment', {
      method: 'POST',
      body: JSON.stringify({
        sourceId,
        currency:  'AUD',
        email:     recheck.email,
        firstName: recheck.firstName,
        lastName:  recheck.lastName,
        address:   recheck.address,
        city:      recheck.city,
        state:     recheck.state,
        postcode:  recheck.postcode,
        phone:     recheck.phone,
        country:   recheck.country,
        items:     cart.map(a => ({ id: a.id })),
      }),
    });

    await squareCard.clear?.();
    await loadArtworks();
    cart = [];
    updateCartUI();
    showSuccess(data.orderId);

  } catch (e) {
    const msg = isSafeServerMessage(e.message)
      ? e.message
      : 'Payment could not be processed. Please check your card details and try again.';
    showPaymentError(msg);
    await squareCard.clear?.();
    const btn = el('pay-btn');
    btn.disabled = false; btn.textContent = 'Complete Purchase';
  }
}

function safeCardError(code) {
  const map = {
    'CVV_FAILURE':             'The security code (CVV) you entered is incorrect.',
    'EXPIRATION_FAILURE':      'The card expiry date is invalid or in the past.',
    'INVALID_CARD':            'Your card details appear to be invalid. Please check and try again.',
    'CARD_DECLINED':           'Your card was declined. Please try a different card.',
    'INSUFFICIENT_FUNDS':      'Your card has insufficient funds.',
    'INVALID_EXPIRATION':      'The expiry date you entered is invalid.',
    'PAN_FAILURE':             'The card number you entered appears to be invalid.',
    'GENERIC_DECLINE':         'Your card was declined. Please try a different card.',
  };
  return map[code] || 'Please check your card details and try again.';
}

function isSafeServerMessage(msg) {
  if (!msg || typeof msg !== 'string') return false;
  const safe = [
    'Too many payment attempts',
    'already sold',
    'Invalid or incomplete form data',
    'An unexpected error occurred',
    'Payment could not be processed',
  ];
  return safe.some(s => msg.includes(s));
}

function showSuccess(orderId) {
  el('checkout-body').style.display = 'none';
  el('success-state').style.display = 'block';
  el('success-order-id').textContent = 'Order ' + orderId;
}

function resetShop() {
  squareCard = null; squarePayments = null;
  el('card-container').innerHTML = '';
  renderGallery();
  closeCheckout();
}

/* ─── HELPER ──────────────────────────────────────────────────────────────── */
function el(id) { return document.getElementById(id); }

/* ─── BOOT ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {

  // Nav
  el('cart-toggle-btn').addEventListener('click', toggleCart);
  el('admin-nav-link').addEventListener('click', e => { e.preventDefault(); openLogin(); });

  // Cart panel
  el('cart-overlay').addEventListener('click', closeCart);
  el('cart-close-btn').addEventListener('click', closeCart);
  el('checkout-btn').addEventListener('click', openCheckout);

  // Checkout modal
  el('checkout-close-btn').addEventListener('click', closeCheckout);
  el('pay-btn').addEventListener('click', handlePayment);

  // Success
  el('success-continue-btn').addEventListener('click', resetShop);

  // Login
  el('login-btn').addEventListener('click', attemptLogin);
  el('login-cancel-btn').addEventListener('click', closeLogin);
  el('admin-pw').addEventListener('keydown', e => { if (e.key === 'Enter') attemptLogin(); });

  // Admin bar
  el('admin-add-btn').addEventListener('click', openAddPanel);
  el('admin-logout-btn').addEventListener('click', adminLogout);

  // Add panel
  el('add-panel-close-btn').addEventListener('click', closeAddPanel);
  el('img-upload-area').addEventListener('click', () => el('img-file').click());
  el('img-file').addEventListener('change', handleImgUpload);
  el('save-painting-btn').addEventListener('click', saveNewPainting);

  // Delete confirm
  el('confirm-cancel-btn').addEventListener('click', closeConfirm);
  el('confirm-delete-btn').addEventListener('click', executeDeletion);

  // Load gallery from API, then check for existing admin session
  await loadArtworks();
  renderGallery();
  updateCartUI();

  if (isLoggedIn()) activateAdminMode();
});
