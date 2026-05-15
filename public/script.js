'use strict';

/* ─── SESSION ─────────────────────────────────────────────────────────────── */
// Admin JWT is stored only in sessionStorage — cleared when the tab closes.
const SESSION_KEY = 'atelier_admin_token';

function getToken()   { try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; } }
function setToken(t)  { try { sessionStorage.setItem(SESSION_KEY, t); }    catch {} }
function clearToken() { try { sessionStorage.removeItem(SESSION_KEY); }    catch {} }
function isLoggedIn() { return !!getToken(); }

/* ─── STATE ───────────────────────────────────────────────────────────────── */
let artworks        = [];
let cart            = [];
let isAdmin         = false;
let pendingDeleteId = null;
let newImgDataArray = [];   // array of base64 data URIs staged for upload
let squareCard      = null;
let squarePayments  = null;
let selectedPostage = null;
let artistPhoto     = null;

// Lightbox state
let lightboxImages  = [];   // array of image URLs currently shown in lightbox
let lightboxIndex   = 0;    // which image is currently displayed
let lightboxTitle   = '';   // painting title shown in lightbox footer

/* ─── API HELPERS ─────────────────────────────────────────────────────────── */
async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type':     'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...(options.headers || {}),
  };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    let errMsg = res.statusText || 'Request failed';
    try {
      const err = await res.json();
      errMsg = err.error || err.message || errMsg;
    } catch {
      if (res.status === 413) {
        errMsg = 'The file is too large. Please resize the image to under 2MB and try again.';
      }
    }
    throw Object.assign(new Error(errMsg), { status: res.status });
  }
  return res.json();
}

/* ─── GALLERY — load from API ─────────────────────────────────────────────── */
async function loadArtworks() {
  try {
    const data  = await apiFetch('/api/get-artworks');
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
      const data  = await apiFetch('/api/update-artist-photo', {
        method: 'POST',
        body:   JSON.stringify({ imgData: ev.target.result }),
      });
      artistPhoto = data.imgUrl || ev.target.result;
      renderArtistPhoto();
    } catch (err) {
      alert('Failed to upload photo. Please try again.');
      console.error(err);
    } finally {
      btn.textContent = 'Change photo';
      btn.disabled    = false;
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

/* ─── GALLERY CARDS ───────────────────────────────────────────────────────── */

/** Builds a single artwork card element. */
function buildCard(art) {
  const card = document.createElement('div');
  card.className = 'artwork-card';
  card.id = 'card-' + art.id;

  // ── Image area ───────────────────────────────────────────────────────────
  // art.images is always a string[] after get-artworks.js normalisation.
  // First image is the hero shown in the card grid.
  // Clicking the image opens the lightbox (all images for this painting).
  const imgWrap = document.createElement('div');
  imgWrap.className = 'artwork-img';

  const heroUrl = art.images && art.images.length > 0 ? art.images[0] : null;

  if (heroUrl) {
    const img = document.createElement('img');
    img.src = heroUrl;
    img.alt = art.title;
    imgWrap.appendChild(img);
  } else if (art.svg) {
    imgWrap.innerHTML = art.svg;
  }

  // Click on image area opens lightbox (only if there are real images)
  if (heroUrl) {
    imgWrap.addEventListener('click', () => openLightbox(art));
  }

  // Show image count badge for paintings with more than one photo
  if (art.images && art.images.length > 1) {
    const badge = document.createElement('span');
    badge.className   = 'artwork-img-count';
    badge.textContent = art.images.length + ' photos';
    imgWrap.appendChild(badge);
  }

  // Sold overlay sits on top of everything in imgWrap
  if (art.sold) {
    const overlay = document.createElement('div');
    overlay.className = 'sold-overlay';
    overlay.textContent = 'Sold';
    imgWrap.appendChild(overlay);
  }

  // ── Label row ────────────────────────────────────────────────────────────
  const labelRow = document.createElement('div'); labelRow.className = 'artwork-label';
  const titleEl  = document.createElement('span'); titleEl.className  = 'artwork-title'; titleEl.textContent = art.title;
  const priceEl  = document.createElement('span'); priceEl.className  = 'artwork-price'; priceEl.textContent = 'AUD $' + art.price.toLocaleString();
  labelRow.appendChild(titleEl); labelRow.appendChild(priceEl);

  const mediumEl = document.createElement('div'); mediumEl.className = 'artwork-medium'; mediumEl.textContent = art.medium;

  // ── Add to cart button ───────────────────────────────────────────────────
  const addBtn = document.createElement('button');
  addBtn.className   = 'add-btn' + (inCart(art.id) ? ' added' : '');
  addBtn.disabled    = art.sold || inCart(art.id);
  addBtn.textContent = art.sold ? 'Sold' : inCart(art.id) ? 'In your selection' : '+ Add to selection';
  addBtn.addEventListener('click', () => addToCart(art.id));

  // ── Admin controls ───────────────────────────────────────────────────────
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

/* ─── LIGHTBOX ────────────────────────────────────────────────────────────── */

/**
 * Opens the lightbox for a given artwork, starting at the given image index.
 * @param {object} art        The artwork object (must have art.images[])
 * @param {number} [startIdx] Which image to open first (default 0)
 */
function openLightbox(art, startIdx = 0) {
  if (!art.images || art.images.length === 0) return;

  lightboxImages = art.images;
  lightboxIndex  = startIdx;
  lightboxTitle  = art.title;

  // Build dot indicators (one per image)
  const dotsEl = el('lightbox-dots');
  dotsEl.innerHTML = '';
  art.images.forEach((_, i) => {
    const dot = document.createElement('button');
    dot.className = 'lightbox-dot' + (i === startIdx ? ' active' : '');
    dot.setAttribute('aria-label', 'Image ' + (i + 1));
    dot.addEventListener('click', () => showLightboxImage(i));
    dotsEl.appendChild(dot);
  });

  // Show/hide nav arrows depending on image count
  const hasMult = art.images.length > 1;
  el('lightbox-prev').classList.toggle('hidden', !hasMult);
  el('lightbox-next').classList.toggle('hidden', !hasMult);

  // Set title in footer
  el('lightbox-title').textContent = art.title;

  // Render first image without fade transition on open
  el('lightbox-img').src = art.images[startIdx];
  el('lightbox-img').alt = art.title;
  updateLightboxCounter();
  updateLightboxNavButtons();

  el('lightbox-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  el('lightbox-overlay').classList.remove('open');
  document.body.style.overflow = '';
  // Clear src after transition so previous image doesn't flash on reopen
  setTimeout(() => {
    el('lightbox-img').src = '';
    lightboxImages = [];
  }, 250);
}

/**
 * Switches to a specific image index with a brief fade transition.
 * Updates the counter, dots, and arrow disabled states.
 */
function showLightboxImage(idx) {
  if (idx < 0 || idx >= lightboxImages.length) return;
  lightboxIndex = idx;

  const imgEl = el('lightbox-img');

  // Fade out → swap src → fade in
  imgEl.classList.add('fading');
  setTimeout(() => {
    imgEl.src = lightboxImages[idx];
    imgEl.alt = lightboxTitle + ' — image ' + (idx + 1);
    imgEl.classList.remove('fading');
  }, 180);

  updateLightboxCounter();
  updateLightboxDots();
  updateLightboxNavButtons();
}

function lightboxNext() {
  if (lightboxIndex < lightboxImages.length - 1) showLightboxImage(lightboxIndex + 1);
}

function lightboxPrev() {
  if (lightboxIndex > 0) showLightboxImage(lightboxIndex - 1);
}

function updateLightboxCounter() {
  const total = lightboxImages.length;
  el('lightbox-counter').textContent = total > 1 ? (lightboxIndex + 1) + ' of ' + total : '';
}

function updateLightboxDots() {
  const dots = el('lightbox-dots').querySelectorAll('.lightbox-dot');
  dots.forEach((dot, i) => dot.classList.toggle('active', i === lightboxIndex));
}

function updateLightboxNavButtons() {
  el('lightbox-prev').disabled = lightboxIndex === 0;
  el('lightbox-next').disabled = lightboxIndex === lightboxImages.length - 1;
}

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
  try {
    await apiFetch('/api/logout', { method: 'POST', body: JSON.stringify({}) });
  } catch (e) {
    console.error('Server logout failed:', e);
  }
  clearToken();
  isAdmin = false;
  el('admin-bar').classList.remove('visible');
  el('admin-nav-link').classList.remove('active');
  el('about-photo-admin').classList.remove('visible');
  el('orders-panel').classList.remove('open');
  document.body.style.overflow = '';
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
    await apiFetch('/api/paintings', { method: 'PATCH', body: JSON.stringify({ id }) });
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
    await apiFetch('/api/paintings', { method: 'DELETE', body: JSON.stringify({ id }) });
    cart = cart.filter(i => i.id !== id);
    await loadArtworks();
    renderGallery();
    updateCartUI();
  } catch (e) {
    console.error('delete failed:', e);
    alert('Could not delete painting. Please try again.');
  }
}

/* ─── ADD PAINTING — multi-image upload ───────────────────────────────────── */

/**
 * Renders the image strip in the add panel from the current newImgDataArray.
 * Each tile shows a thumbnail and a × remove button.
 * The "+ Add photos" button is hidden when 10 images are staged.
 */
function renderImgStrip() {
  const strip   = el('img-strip');
  const addWrap = el('img-strip-add');
  strip.innerHTML = '';

  newImgDataArray.forEach((dataUri, i) => {
    const tile = document.createElement('div');
    tile.className = 'img-strip-thumb';

    const img = document.createElement('img');
    img.src = dataUri;
    img.alt = 'Image ' + (i + 1);
    tile.appendChild(img);

    const removeBtn = document.createElement('button');
    removeBtn.className   = 'img-strip-remove';
    removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', 'Remove image ' + (i + 1));
    removeBtn.addEventListener('click', () => {
      newImgDataArray.splice(i, 1);
      renderImgStrip();
    });
    tile.appendChild(removeBtn);

    strip.appendChild(tile);
  });

  // Hide the add button once the 10-image limit is reached
  addWrap.style.display = newImgDataArray.length >= 10 ? 'none' : '';
}

function openAddPanel() {
  el('add-panel').classList.add('open');
  document.body.style.overflow = 'hidden';

  // Reset all fields
  ['new-title', 'new-medium', 'new-price',
   'new-weight', 'new-length', 'new-width', 'new-height'].forEach(id => el(id).value = '');
  el('new-category').value    = 'seascape';
  el('new-sold').checked      = false;
  el('add-error').textContent = '';

  // Reset image state
  newImgDataArray = [];
  renderImgStrip();
  el('img-file').value = ''; // clear so same files can be re-selected
}

function closeAddPanel() {
  el('add-panel').classList.remove('open');
  document.body.style.overflow = '';
}

/**
 * Handles the file input change event for the multi-image upload.
 * Reads each selected file as a base64 data URI and appends to newImgDataArray.
 * Enforces the 10-image cap — excess files are silently dropped with a message.
 */
function handleImgUpload(e) {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  const remaining = 10 - newImgDataArray.length;
  const toLoad    = files.slice(0, remaining);

  if (files.length > remaining) {
    el('add-error').textContent =
      'Maximum 10 images per painting. ' +
      (files.length - remaining) + ' file(s) were not added.';
  } else {
    el('add-error').textContent = '';
  }

  let loaded = 0;
  toLoad.forEach(file => {
    const reader = new FileReader();
    reader.onload = ev => {
      newImgDataArray.push(ev.target.result);
      loaded++;
      if (loaded === toLoad.length) renderImgStrip();
    };
    reader.readAsDataURL(file);
  });

  // Reset so the same file(s) can be selected again if needed
  e.target.value = '';
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

  errEl.textContent = '';
  const btn = el('save-painting-btn');
  btn.disabled    = true;
  btn.textContent = newImgDataArray.length > 0
    ? 'Uploading ' + newImgDataArray.length + ' image' + (newImgDataArray.length > 1 ? 's' : '') + '…'
    : 'Saving…';

  try {
    const data = await apiFetch('/api/paintings', {
      method: 'POST',
      body:   JSON.stringify({
        title, medium, price, category, sold,
        weight, length, width, height,
        imgDataArray: newImgDataArray,   // full array (may be empty)
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
    btn.disabled    = false;
    btn.textContent = 'Save painting to gallery';
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
  el('cart-count').textContent = count;
  el('checkout-btn').disabled  = count === 0;
  const total = cart.reduce((s, i) => s + i.price, 0);
  el('cart-total').textContent = 'AUD $' + total.toLocaleString();

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
    const item  = document.createElement('div'); item.className = 'cart-item';
    const thumb = document.createElement('div'); thumb.className = 'cart-item-thumb';

    // Use first image from images[] for the cart thumbnail
    const heroUrl = art.images && art.images.length > 0 ? art.images[0] : null;
    if (heroUrl) {
      const img = document.createElement('img');
      img.src = heroUrl; img.alt = art.title;
      thumb.appendChild(img);
    } else if (art.svg) {
      thumb.innerHTML = art.svg;
    }

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

  const postageRow   = document.createElement('div'); postageRow.className = 'order-line';
  const postageLabel = document.createElement('span');
  postageLabel.textContent = selectedPostage ? selectedPostage.name : 'Postage (select below)';
  if (!selectedPostage) postageLabel.style.color = 'var(--gold)';
  const postagePrice = document.createElement('span');
  postagePrice.textContent = selectedPostage ? 'AUD $' + selectedPostage.price.toFixed(2) : '—';
  postageRow.appendChild(postageLabel); postageRow.appendChild(postagePrice);
  summaryEl.appendChild(postageRow);

  const totalRow = document.createElement('div'); totalRow.className = 'order-line total';
  totalRow.innerHTML = '<strong>Total</strong><strong>AUD $' + grandTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</strong>';
  summaryEl.appendChild(totalRow);
}

function updateOrderSummary() { buildOrderSummary(); }

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

/* ─── ORDERS PANEL ────────────────────────────────────────────────────────── */
async function openOrders() {
  el('orders-panel').classList.add('open');
  document.body.style.overflow = 'hidden';
  await renderOrders();
}
function closeOrders() {
  el('orders-panel').classList.remove('open');
  document.body.style.overflow = '';
}

async function renderOrders() {
  const body = el('orders-panel-body');
  body.innerHTML = '<div class="orders-loading">Loading orders…</div>';

  try {
    const data   = await apiFetch('/api/get-orders');
    const orders = data.orders || [];

    if (orders.length === 0) {
      body.innerHTML = '<div class="orders-empty">No orders yet.</div>';
      return;
    }

    const frag = document.createDocumentFragment();

    orders.forEach(order => {
      const card = document.createElement('div');
      card.className = 'order-card';

      const head = document.createElement('div');
      head.className = 'order-card-head';
      const idEl = document.createElement('span');
      idEl.className   = 'order-card-id';
      idEl.textContent = 'Order ' + order.orderId;
      const dateEl = document.createElement('span');
      dateEl.className   = 'order-card-date';
      dateEl.textContent = order.ts
        ? new Date(order.ts).toLocaleString('en-AU', {
            day: 'numeric', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
          })
        : '—';
      head.appendChild(idEl);
      head.appendChild(dateEl);

      const cardBody = document.createElement('div');
      cardBody.className = 'order-card-body';

      const worksLabel = document.createElement('div');
      worksLabel.className   = 'order-section-label';
      worksLabel.textContent = 'Works Sold';
      cardBody.appendChild(worksLabel);

      (order.items || []).forEach(item => {
        const row = document.createElement('div'); row.className = 'order-item-row';
        const title = document.createElement('span'); title.className = 'order-item-title'; title.textContent = item.title;
        const price = document.createElement('span'); price.className = 'order-item-price'; price.textContent = 'AUD $' + Number(item.price).toLocaleString();
        row.appendChild(title); row.appendChild(price);
        cardBody.appendChild(row);
      });

      const postageRow = document.createElement('div'); postageRow.className = 'order-postage-row';
      const postageLabel = document.createElement('span'); postageLabel.textContent = order.postageName || 'Postage';
      const postagePrice = document.createElement('span'); postagePrice.textContent = 'AUD $' + Number(order.postagePrice).toFixed(2);
      postageRow.appendChild(postageLabel); postageRow.appendChild(postagePrice);
      cardBody.appendChild(postageRow);

      const totalRow = document.createElement('div'); totalRow.className = 'order-total-row';
      const totalLabel = document.createElement('span'); totalLabel.className = 'order-total-label'; totalLabel.textContent = 'Total Charged';
      const totalAmount = document.createElement('span'); totalAmount.className = 'order-total-amount'; totalAmount.textContent = 'AUD $' + Number(order.grandTotal).toFixed(2);
      totalRow.appendChild(totalLabel); totalRow.appendChild(totalAmount);
      cardBody.appendChild(totalRow);

      const custLabel = document.createElement('div'); custLabel.className = 'order-section-label'; custLabel.textContent = 'Customer';
      cardBody.appendChild(custLabel);
      const custGrid = document.createElement('div'); custGrid.className = 'order-detail-grid';
      const c = order.customer || {};
      [['Name', (c.firstName || '') + ' ' + (c.lastName || '')], ['Email', c.email || '—'], ['Phone', c.phone || '—']].forEach(([key, val]) => {
        const k = document.createElement('span'); k.className = 'order-detail-key'; k.textContent = key;
        const v = document.createElement('span'); v.className = 'order-detail-val';
        if (key === 'Email' && c.email) { const a = document.createElement('a'); a.href = 'mailto:' + c.email; a.textContent = c.email; v.appendChild(a); }
        else v.textContent = val;
        custGrid.appendChild(k); custGrid.appendChild(v);
      });
      cardBody.appendChild(custGrid);

      const shipLabel = document.createElement('div'); shipLabel.className = 'order-section-label'; shipLabel.textContent = 'Ship To';
      cardBody.appendChild(shipLabel);
      const shipGrid = document.createElement('div'); shipGrid.className = 'order-detail-grid';
      const s = order.shipping || {};
      [['Address', s.address || '—'], ['City', s.city || '—'], ['State', s.state || '—'], ['Postcode', s.postcode || '—'], ['Country', s.country || '—']].forEach(([key, val]) => {
        const k = document.createElement('span'); k.className = 'order-detail-key'; k.textContent = key;
        const v = document.createElement('span'); v.className = 'order-detail-val'; v.textContent = val;
        shipGrid.appendChild(k); shipGrid.appendChild(v);
      });
      cardBody.appendChild(shipGrid);

      card.appendChild(head);
      card.appendChild(cardBody);
      frag.appendChild(card);
    });

    el('orders-panel-body').innerHTML = '';
    el('orders-panel-body').appendChild(frag);

  } catch (e) {
    el('orders-panel-body').innerHTML = '<div class="orders-empty">Could not load orders. Please try again.</div>';
    console.error('renderOrders error:', e);
  }
}

/* ─── POSTAGE ─────────────────────────────────────────────────────────────── */
async function calculatePostage() {
  const postcode = el('buyer-postcode').value.trim();
  const resultEl = el('postage-result');
  const btn      = el('postage-calc-btn');

  if (!postcode || !/^[0-9]{4}$/.test(postcode)) {
    resultEl.innerHTML = '<p class="postage-error">Please enter a valid 4-digit postcode.</p>';
    return;
  }

  const itemsWithShipping = cart.filter(a => a.shipping?.weight > 0);
  if (itemsWithShipping.length === 0) {
    resultEl.innerHTML = '<p class="postage-error">Shipping details are not yet available for this item. Please <a href="#contact" class="postage-contact-link">contact Michael</a> for a quote.</p>';
    btn.disabled = false; btn.textContent = 'Calculate';
    return;
  }

  const heaviest = itemsWithShipping.reduce((max, art) =>
    art.shipping.weight > max.shipping.weight ? art : max
  , itemsWithShipping[0]);
  const shipping = heaviest.shipping;

  btn.disabled = true; btn.textContent = 'Calculating…';
  resultEl.innerHTML = '<p class="postage-loading">Fetching rates from Australia Post…</p>';

  try {
    const data = await apiFetch('/api/postage', {
      method: 'POST',
      body: JSON.stringify({ toPostcode: postcode, weight: shipping.weight, length: shipping.length, width: shipping.width, height: shipping.height }),
    });

    if (data.services && data.services.length > 0) {
      selectedPostage = null;
      const servicesWrap = document.createElement('div');
      servicesWrap.className = 'postage-services';
      const note = document.createElement('p');
      note.className = 'postage-note';
      note.textContent = `Postage from Airlie Beach (4802) to ${postcode}${cart.length > 1 ? ' — quoted for largest item' : ''}. Select a service:`;
      servicesWrap.appendChild(note);

      data.services.forEach((s, i) => {
        const label = document.createElement('label');
        label.className = 'postage-service postage-service-selectable';
        label.htmlFor   = 'postage-option-' + i;
        const radio = document.createElement('input');
        radio.type = 'radio'; radio.name = 'postage-option'; radio.id = 'postage-option-' + i;
        radio.value = i; radio.className = 'postage-radio';
        radio.addEventListener('change', () => {
          selectedPostage = { name: s.name, price: s.price, quoteId: s.quoteId };
          updateOrderSummary();
          el('payment-error').style.display = 'none';
        });
        const nameSpan = document.createElement('span'); nameSpan.className = 'postage-service-name'; nameSpan.textContent = s.name;
        const detailsSpan = document.createElement('span'); detailsSpan.className = 'postage-service-details';
        if (s.deliveryTime) { const d = document.createElement('span'); d.className = 'postage-delivery'; d.textContent = s.deliveryTime; detailsSpan.appendChild(d); }
        const priceSpan = document.createElement('span'); priceSpan.className = 'postage-price'; priceSpan.textContent = 'AUD $' + s.price.toFixed(2);
        detailsSpan.appendChild(priceSpan);
        label.appendChild(radio); label.appendChild(nameSpan); label.appendChild(detailsSpan);
        servicesWrap.appendChild(label);
      });

      const disclaimer = document.createElement('p');
      disclaimer.className = 'postage-disclaimer';
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
    btn.disabled = false; btn.textContent = 'Calculate';
  }
}

/* ─── CONTACT FORM ────────────────────────────────────────────────────────── */
async function submitContactForm() {
  const errEl  = el('contact-form-error');
  const succEl = el('contact-form-success');
  const btn    = el('contact-form-btn');

  try {
    const name    = el('contact-name').value.trim();
    const email   = el('contact-email').value.trim();
    const message = el('contact-message').value.trim();
    errEl.textContent = ''; succEl.textContent = '';

    if (!name)    { errEl.textContent = 'Please enter your name.'; return; }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = 'Please enter a valid email address.'; return; }
    if (!message) { errEl.textContent = 'Please enter a message.'; return; }

    btn.disabled = true; btn.textContent = 'Sending…';

    const data = await apiFetch('/api/contact', { method: 'POST', body: JSON.stringify({ name, email, message }) });

    if (data.fallback) {
      errEl.innerHTML = data.error + ' — <a href="mailto:michael.p.vanblerk@gmail.com" style="color:#f5a0a0;">michael.p.vanblerk@gmail.com</a>';
      return;
    }
    succEl.textContent = 'Message sent — Michael will be in touch soon.';
    el('contact-name').value = ''; el('contact-email').value = ''; el('contact-message').value = '';
  } catch (e) {
    errEl.textContent = e.message || 'Message could not be sent. Please email Michael directly.';
  } finally {
    btn.disabled = false; btn.textContent = 'Send message';
  }
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
  errEl.textContent = msg; errEl.style.display = 'block';
}

/* ─── FORM FIELD HELPERS ──────────────────────────────────────────────────── */
function fieldVal(id)       { return el(id).value.trim(); }
function hasHtml(str)       { return /[<>]/.test(str); }
function validPhone(str)    { return /^[0-9+\s\-]{6,20}$/.test(str); }
function validPostcode(str) { return /^[0-9]{4,10}$/.test(str); }
function validEmail(str)    { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str); }

function validateForm() {
  const textFields = [
    ['first-name', 'First name'], ['last-name', 'Last name'],
    ['address', 'Street address'], ['city', 'City'],
    ['state', 'State'], ['country', 'Country'],
  ];
  for (const [id, label] of textFields) {
    const val = fieldVal(id);
    if (!val) { showPaymentError('Please enter your ' + label + '.'); return null; }
    if (hasHtml(val)) { showPaymentError(label + ' must not contain HTML characters.'); return null; }
  }
  const email = fieldVal('email');
  if (!email) { showPaymentError('Please enter your email address.'); return null; }
  if (hasHtml(email) || !validEmail(email)) { showPaymentError('Please enter a valid email address.'); return null; }
  const phone = fieldVal('phone');
  if (phone && !validPhone(phone)) { showPaymentError('Please enter a valid phone number (digits, spaces, + and - only).'); return null; }
  const postcode = fieldVal('postcode');
  if (!postcode) { showPaymentError('Please enter your postcode.'); return null; }
  if (!validPostcode(postcode)) { showPaymentError('Postcode must be numeric only.'); return null; }
  return {
    firstName: fieldVal('first-name'), lastName: fieldVal('last-name'),
    email, phone, address: fieldVal('address'), city: fieldVal('city'),
    state: fieldVal('state'), postcode, country: fieldVal('country'),
  };
}

async function handlePayment() {
  el('payment-error').style.display = 'none';
  const fields = validateForm();
  if (!fields) return;
  if (!selectedPostage) { showPaymentError('Please calculate postage and select a shipping option before completing your purchase.'); return; }
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
  if (!recheck) { const btn = el('pay-btn'); btn.disabled = false; btn.textContent = 'Complete Purchase'; return; }
  if (!selectedPostage) {
    showPaymentError('Please select a postage option before completing your purchase.');
    const btn = el('pay-btn'); btn.disabled = false; btn.textContent = 'Complete Purchase'; return;
  }
  try {
    const data = await apiFetch('/api/create-payment', {
      method: 'POST',
      body: JSON.stringify({
        sourceId, currency: 'AUD',
        email: recheck.email, firstName: recheck.firstName, lastName: recheck.lastName,
        address: recheck.address, city: recheck.city, state: recheck.state,
        postcode: recheck.postcode, phone: recheck.phone, country: recheck.country,
        items: cart.map(a => ({ id: a.id })),
        postageQuoteId: selectedPostage.quoteId,
      }),
    });
    await squareCard.clear?.();
    await loadArtworks();
    cart = []; selectedPostage = null;
    updateCartUI();
    showSuccess(data.orderId);
  } catch (e) {
    const msg = isSafeServerMessage(e.message)
      ? e.message
      : 'Payment could not be processed. Please check your card details and try again.';
    showPaymentError(msg);
    await squareCard.clear?.();
    const btn = el('pay-btn'); btn.disabled = false; btn.textContent = 'Complete Purchase';
  }
}

function safeCardError(code) {
  const map = {
    'CVV_FAILURE': 'The security code (CVV) you entered is incorrect.',
    'EXPIRATION_FAILURE': 'The card expiry date is invalid or in the past.',
    'INVALID_CARD': 'Your card details appear to be invalid. Please check and try again.',
    'CARD_DECLINED': 'Your card was declined. Please try a different card.',
    'INSUFFICIENT_FUNDS': 'Your card has insufficient funds.',
    'INVALID_EXPIRATION': 'The expiry date you entered is invalid.',
    'PAN_FAILURE': 'The card number you entered appears to be invalid.',
    'GENERIC_DECLINE': 'Your card was declined. Please try a different card.',
  };
  return map[code] || 'Please check your card details and try again.';
}

function isSafeServerMessage(msg) {
  if (!msg || typeof msg !== 'string') return false;
  return ['Too many payment attempts', 'already sold', 'Invalid or incomplete form data',
          'An unexpected error occurred', 'Payment could not be processed', 'Invalid postage']
    .some(s => msg.includes(s));
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
  el('admin-orders-btn').addEventListener('click', openOrders);
  el('admin-add-btn').addEventListener('click', openAddPanel);
  el('admin-logout-btn').addEventListener('click', adminLogout);

  // Orders panel
  el('orders-close-btn').addEventListener('click', closeOrders);

  // Artist photo (admin)
  el('artist-photo-upload-btn').addEventListener('click', () => el('artist-photo-file').click());
  el('artist-photo-file').addEventListener('change', handleArtistPhotoUpload);
  el('artist-photo-remove-btn').addEventListener('click', removeArtistPhoto);

  // Add painting panel
  el('add-panel-close-btn').addEventListener('click', closeAddPanel);
  el('img-strip-add-btn').addEventListener('click', () => el('img-file').click());
  el('img-file').addEventListener('change', handleImgUpload);
  el('save-painting-btn').addEventListener('click', saveNewPainting);

  // Contact form
  el('contact-form-btn').addEventListener('click', submitContactForm);

  // Delete confirm
  el('confirm-cancel-btn').addEventListener('click', closeConfirm);
  el('confirm-delete-btn').addEventListener('click', executeDeletion);

  // Lightbox
  el('lightbox-close').addEventListener('click', closeLightbox);
  el('lightbox-prev').addEventListener('click', lightboxPrev);
  el('lightbox-next').addEventListener('click', lightboxNext);

  // Close lightbox on backdrop click (but not on image or nav buttons)
  el('lightbox-overlay').addEventListener('click', e => {
    if (e.target === el('lightbox-overlay')) closeLightbox();
  });

  // Keyboard navigation for lightbox
  document.addEventListener('keydown', e => {
    if (!el('lightbox-overlay').classList.contains('open')) return;
    if (e.key === 'Escape')     closeLightbox();
    if (e.key === 'ArrowRight') lightboxNext();
    if (e.key === 'ArrowLeft')  lightboxPrev();
  });

  // Load gallery from API, then check for existing admin session
  await loadArtworks();
  renderGallery();
  updateCartUI();

  if (isLoggedIn()) activateAdminMode();
});
