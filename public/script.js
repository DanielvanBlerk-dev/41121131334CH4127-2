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
let selectedPostage = null;
let artistPhoto     = null; // base64 data URI of artist photo, loaded from Redis

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
    artworks    = data.artworks    || [];
    artistPhoto = data.artistPhoto || null;
    renderArtistPhoto();
  } catch (e) {
    console.error('Failed to load artworks:', e);
    artworks    = [];
    artistPhoto = null;
  }
}

/* ─── ARTIST PHOTO ────────────────────────────────────────────────────────── */
function renderArtistPhoto() {
  const wrap  = el('about-photo');
  const label = el('about-photo-label');
  // Clear existing image if any
  const existing = wrap.querySelector('img');
  if (existing) existing.remove();

  if (artistPhoto) {
    const img = document.createElement('img');
    img.src = artistPhoto;
    img.alt = 'Michael van Blerk — artist';
    wrap.appendChild(img);
    if (label) label.style.display = 'none';
  } else {
    if (label) label.style.display = '';
  }
}

async function handleArtistPhotoUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const btn = el('artist-photo-upload-btn');
  btn.textContent = 'Uploading…';
  btn.disabled    = true;

  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      await apiFetch('/api/update-artist-photo', {
        method: 'POST',
        body:   JSON.stringify({ imgData: ev.target.result }),
      });
      artistPhoto = ev.target.result;
      renderArtistPhoto();
    } catch (err) {
      alert('Failed to upload photo. Please try again.');
      console.error(err);
    } finally {
      btn.textContent = 'Change photo';
      btn.disabled    = false;
      // Reset file input so same file can be re-selected
      el('artist-photo-file').value = '';
    }
  };
  reader.readAsDataURL(file);
}

async function removeArtistPhoto() {
  if (!confirm('Remove the artist photo?')) return;
  try {
    await apiFetch('/api/update-artist-photo', { method: 'DELETE', body: JSON.stringify({}) });
    artistPhoto = null;
    renderArtistPhoto();
  } catch (err) {
    alert('Failed to remove photo. Please try again.');
    console.error(err);
  }
}



/** Builds a single artwork card element. */
function buildCard(art) {
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
  const labelRow = document.createElement('div'); labelRow.className = 'artwork-label';
  const titleEl  = document.createElement('span'); titleEl.className  = 'artwork-title'; titleEl.textContent = art.title;
  const priceEl  = document.createElement('span'); priceEl.className  = 'artwork-price'; priceEl.textContent = 'AUD $' + art.price.toLocaleString();
  labelRow.appendChild(titleEl); labelRow.appendChild(priceEl);

  const mediumEl = document.createElement('div'); mediumEl.className = 'artwork-medium'; mediumEl.textContent = art.medium;

  // Add to cart button
  const addBtn = document.createElement('button');
  addBtn.className   = 'add-btn' + (inCart(art.id) ? ' added' : '');
  addBtn.disabled    = art.sold || inCart(art.id);
  addBtn.textContent = art.sold ? 'Sold' : inCart(art.id) ? 'In your selection' : '+ Add to selection';
  addBtn.addEventListener('click', () => addToCart(art.id));

  // Admin controls
  const adminCtrl = document.createElement('div');
  adminCtrl.className = 'admin-controls' + (isAdmin ? ' visible' : '');

  const soldBtn = document.createElement('button');
  soldBtn.className   = 'admin-ctrl-btn sold-toggle';
  soldBtn.textContent = art.sold ? 'Mark available' : 'Mark sold';
  soldBtn.addEventListener('click', () => toggleSold(art.id));

  const delBtn = document.createElement('button');
  delBtn.className   = 'admin-ctrl-btn del';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', () => confirmDelete(art.id, art.title));

  adminCtrl.appendChild(soldBtn);
  adminCtrl.appendChild(delBtn);

  card.appendChild(imgWrap); card.appendChild(labelRow); card.appendChild(mediumEl);
  card.appendChild(addBtn);  card.appendChild(adminCtrl);
  return card;
}

/** Populates a grid element with cards, or shows an empty message. */
function populateGrid(gridEl, items) {
  gridEl.innerHTML = '';
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className   = 'gallery-empty';
    empty.textContent = 'No works in this collection yet.';
    gridEl.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  items.forEach(art => frag.appendChild(buildCard(art)));
  gridEl.appendChild(frag);
}

function renderGallery() {
  const seascapes  = artworks.filter(a => a.category === 'seascape');
  const figurative = artworks.filter(a => a.category === 'figurative' || !a.category);

  populateGrid(el('gallery-seascapes'),  seascapes);
  populateGrid(el('gallery-figurative'), figurative);
}

function inCart(id) { return cart.some(i => i.id === id); }

/* ─── ADMIN AUTH ──────────────────────────────────────────────────────────── */
function openLogin() {
  el('admin-pw').value = '';
  el('login-error').textContent = '';
  el('login-overlay').classList.add('open');
  setTimeout(() => el('admin-pw').focus(), 200);
}
function closeLogin() {
  el('login-overlay').classList.remove('open');
  el('admin-pw').type             = 'password';
  el('pw-toggle-btn').textContent = 'Show';
}

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
    const msg =
      e.status === 401 ? 'Incorrect password.' :
      e.status === 403 ? 'Login blocked. Ensure ALLOWED_ORIGIN is set in Vercel.' :
      e.status === 429 ? (e.message || 'Too many attempts. Please wait before trying again.') :
      'Login failed. Please try again.';
    el('login-error').textContent = msg;
    el('admin-pw').value = '';
    setTimeout(() => el('admin-pw').focus(), 50);
  } finally {
    btnEl.disabled    = false;
    btnEl.textContent = 'Sign in';
  }
}

async function adminLogout() {
  // Tell the server to rotate the token version first.
  // This invalidates the current JWT in Redis even if it hasn't expired.
  // We clear locally regardless of whether the server call succeeds —
  // the user is always logged out on this device either way.
  try {
    await apiFetch('/api/logout', { method: 'POST', body: JSON.stringify({}) });
  } catch (e) {
    // Server-side rotation failed (network issue, etc.) — still log out locally.
    // The token will expire naturally after 12h.
    console.error('Server logout failed:', e);
  }

  clearToken();
  isAdmin = false;
  el('admin-bar').classList.remove('visible');
  el('admin-nav-link').classList.remove('active');
  el('about-photo-admin').classList.remove('visible');
  renderGallery();
}

function activateAdminMode() {
  isAdmin = true;
  el('admin-bar').classList.add('visible');
  el('admin-nav-link').classList.add('active');
  el('about-photo-admin').classList.add('visible');
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
  ['new-title', 'new-medium', 'new-price',
   'new-weight', 'new-length', 'new-width', 'new-height'].forEach(id => el(id).value = '');
  el('new-category').value = 'seascape';
  el('new-sold').checked   = false;
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
  const category = el('new-category').value;
  const sold     = el('new-sold').checked;
  const weight   = parseFloat(el('new-weight').value);
  const length   = parseFloat(el('new-length').value);
  const width    = parseFloat(el('new-width').value);
  const height   = parseFloat(el('new-height').value);
  const errEl    = el('add-error');

  if (!title)  { errEl.textContent = 'Please enter a title.'; return; }
  if (!medium) { errEl.textContent = 'Please enter the medium and dimensions.'; return; }
  const price = parseInt(priceRaw, 10);
  if (!priceRaw || isNaN(price) || price < 0) { errEl.textContent = 'Please enter a valid price.'; return; }
  if (isNaN(weight) || weight <= 0) { errEl.textContent = 'Please enter the packed weight in kg.'; return; }
  if (isNaN(length) || length <= 0) { errEl.textContent = 'Please enter the packed length in cm.'; return; }
  if (isNaN(width)  || width  <= 0) { errEl.textContent = 'Please enter the packed width in cm.'; return; }
  if (isNaN(height) || height <= 0) { errEl.textContent = 'Please enter the packed height in cm.'; return; }

  const btn = el('save-painting-btn');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const data = await apiFetch('/api/add-painting', {
      method: 'POST',
      body:   JSON.stringify({
        title, medium, price, category, sold,
        weight, length, width, height,
        imgData: newImgData || null,
      }),
    });
    await loadArtworks();
    renderGallery();
    closeAddPanel();
    setTimeout(() => {
      const card = document.getElementById('card-' + data.id);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
  } catch (e) {
    errEl.textContent = e.message || 'Failed to save painting. Please try again.';
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
  const artworkTotal = cart.reduce((s, i) => s + i.price, 0);
  const postageTotal = selectedPostage ? selectedPostage.price : 0;
  const grandTotal   = artworkTotal + postageTotal;
  const summaryEl    = el('order-summary');
  summaryEl.innerHTML = '';

  // Artwork lines
  cart.forEach(a => {
    const row      = document.createElement('div'); row.className = 'order-line';
    const nameSpan = document.createElement('span');
    const em       = document.createElement('em'); em.textContent = a.title;
    nameSpan.appendChild(em);
    const priceSpan = document.createElement('span');
    priceSpan.textContent = 'AUD $' + a.price.toLocaleString();
    row.appendChild(nameSpan); row.appendChild(priceSpan);
    summaryEl.appendChild(row);
  });

  // Postage line — shows selected service or placeholder
  const postageRow = document.createElement('div'); postageRow.className = 'order-line';
  const postageLabel = document.createElement('span');
  postageLabel.textContent = selectedPostage ? selectedPostage.name : 'Postage (select above)';
  if (!selectedPostage) postageLabel.style.color = 'var(--gold)';
  const postagePrice = document.createElement('span');
  postagePrice.textContent = selectedPostage ? 'AUD $' + selectedPostage.price.toFixed(2) : '—';
  postageRow.appendChild(postageLabel); postageRow.appendChild(postagePrice);
  summaryEl.appendChild(postageRow);

  // Grand total
  const totalRow = document.createElement('div'); totalRow.className = 'order-line total';
  totalRow.innerHTML = '<strong>Total</strong><strong>AUD $' + grandTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</strong>';
  summaryEl.appendChild(totalRow);
}

// Re-renders the order summary whenever postage selection changes
function updateOrderSummary() {
  buildOrderSummary();
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
  el('postage-result').innerHTML = '';
  el('buyer-postcode').value = '';
  selectedPostage = null;
  document.body.style.overflow = '';
}

/* ─── POSTAGE CALCULATOR ──────────────────────────────────────────────────── */
async function calculatePostage() {
  const postcode   = el('buyer-postcode').value.trim();
  const resultEl   = el('postage-result');
  const btn        = el('postage-calc-btn');

  if (!postcode || !/^[0-9]{4}$/.test(postcode)) {
    resultEl.innerHTML = '<p class="postage-error">Please enter a valid 4-digit postcode.</p>';
    return;
  }

  // Find the item with the largest dimensions — drives the postage cost.
  // Gracefully handle artworks that predate the shipping fields.
  const itemsWithShipping = cart.filter(a => a.shipping?.weight > 0);

  if (itemsWithShipping.length === 0) {
    resultEl.innerHTML = '<p class="postage-error">Shipping details are not yet available for this item. Please <a href="#contact" class="postage-contact-link">contact Michael</a> for a quote.</p>';
    btn.disabled    = false;
    btn.textContent = 'Calculate';
    return;
  }

  const heaviest = itemsWithShipping.reduce((max, art) =>
    art.shipping.weight > max.shipping.weight ? art : max
  , itemsWithShipping[0]);

  const shipping = heaviest.shipping;

  btn.disabled    = true;
  btn.textContent = 'Calculating…';
  resultEl.innerHTML = '<p class="postage-loading">Fetching rates from Australia Post…</p>';

  try {
    const data = await apiFetch('/api/postage', {
      method: 'POST',
      body: JSON.stringify({
        toPostcode: postcode,
        weight:     shipping.weight,
        length:     shipping.length,
        width:      shipping.width,
        height:     shipping.height,
      }),
    });

    if (data.services && data.services.length > 0) {
      // Reset any previously selected postage
      selectedPostage = null;

      const servicesWrap = document.createElement('div');
      servicesWrap.className = 'postage-services';

      const note = document.createElement('p');
      note.className   = 'postage-note';
      note.textContent = `Postage from Airlie Beach (4802) to ${postcode}${cart.length > 1 ? ' — quoted for largest item' : ''}. Select a service:`;
      servicesWrap.appendChild(note);

      data.services.forEach((s, i) => {
        const label = document.createElement('label');
        label.className = 'postage-service postage-service-selectable';
        label.htmlFor   = 'postage-option-' + i;

        const radio = document.createElement('input');
        radio.type    = 'radio';
        radio.name    = 'postage-option';
        radio.id      = 'postage-option-' + i;
        radio.value   = i;
        radio.className = 'postage-radio';
        radio.addEventListener('change', () => {
          selectedPostage = { name: s.name, price: s.price, quoteId: s.quoteId };
          updateOrderSummary();
          el('payment-error').style.display = 'none';
        });

        const nameSpan = document.createElement('span');
        nameSpan.className   = 'postage-service-name';
        nameSpan.textContent = s.name;

        const detailsSpan = document.createElement('span');
        detailsSpan.className = 'postage-service-details';

        if (s.deliveryTime) {
          const delSpan = document.createElement('span');
          delSpan.className   = 'postage-delivery';
          delSpan.textContent = s.deliveryTime;
          detailsSpan.appendChild(delSpan);
        }

        const priceSpan = document.createElement('span');
        priceSpan.className   = 'postage-price';
        priceSpan.textContent = 'AUD $' + s.price.toFixed(2);
        detailsSpan.appendChild(priceSpan);

        label.appendChild(radio);
        label.appendChild(nameSpan);
        label.appendChild(detailsSpan);
        servicesWrap.appendChild(label);
      });

      const disclaimer = document.createElement('p');
      disclaimer.className   = 'postage-disclaimer';
      disclaimer.textContent = 'Selected postage will be added to your total. Michael will confirm and dispatch once payment is received.';
      servicesWrap.appendChild(disclaimer);

      resultEl.innerHTML = '';
      resultEl.appendChild(servicesWrap);

    } else {
      selectedPostage = null;
      resultEl.innerHTML = `<p class="postage-error">${data.message || 'No postage options found. Please <a href="#contact" class="postage-contact-link">contact Michael</a> for a quote.'}</p>`;
    }
  } catch (e) {
    resultEl.innerHTML = '<p class="postage-error">Could not calculate postage. Please <a href="#contact" class="postage-contact-link">contact Michael</a> for a shipping quote.</p>';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Calculate';
  }
}


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

  // Require a postage option to be selected
  if (!selectedPostage) {
    showPaymentError('Please calculate postage and select a shipping option before completing your purchase.');
    return;
  }

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

  if (!selectedPostage) {
    showPaymentError('Please select a postage option before completing your purchase.');
    const btn = el('pay-btn');
    btn.disabled = false; btn.textContent = 'Complete Purchase';
    return;
  }

  try {
    const data = await apiFetch('/api/create-payment', {
      method: 'POST',
      body: JSON.stringify({
        sourceId,
        currency:    'AUD',
        email:       recheck.email,
        firstName:   recheck.firstName,
        lastName:    recheck.lastName,
        address:     recheck.address,
        city:        recheck.city,
        state:       recheck.state,
        postcode:    recheck.postcode,
        phone:       recheck.phone,
        country:     recheck.country,
        items:       cart.map(a => ({ id: a.id })),
        postageQuoteId: selectedPostage.quoteId,  // server looks this up — client never sets price
      }),
    });

    await squareCard.clear?.();
    await loadArtworks();
    cart = [];
    selectedPostage = null;
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
    'Invalid postage',
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
  el('postage-calc-btn').addEventListener('click', calculatePostage);
  el('buyer-postcode').addEventListener('keydown', e => { if (e.key === 'Enter') calculatePostage(); });

  // Success
  el('success-continue-btn').addEventListener('click', resetShop);

  // Login
  el('login-btn').addEventListener('click', attemptLogin);
  el('login-cancel-btn').addEventListener('click', closeLogin);
  el('admin-pw').addEventListener('keydown', e => { if (e.key === 'Enter') attemptLogin(); });
  el('pw-toggle-btn').addEventListener('click', () => {
    const input = el('admin-pw');
    const btn   = el('pw-toggle-btn');
    const show  = input.type === 'password';
    input.type      = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  // Admin bar
  el('admin-add-btn').addEventListener('click', openAddPanel);
  el('admin-logout-btn').addEventListener('click', adminLogout);

  // Artist photo (admin)
  el('artist-photo-upload-btn').addEventListener('click', () => el('artist-photo-file').click());
  el('artist-photo-file').addEventListener('change', handleArtistPhotoUpload);
  el('artist-photo-remove-btn').addEventListener('click', removeArtistPhoto);
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
