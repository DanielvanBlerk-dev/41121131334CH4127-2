'use strict';

/* ─── BROWSER COMPATIBILITY BANNER ───────────────────────────────────────────
 *
 * Shows when the gallery fails to load — catches any browser that blocks
 * the fetch() call (e.g. some in-app browsers).
 * Only triggers if artworks is empty after the API call completes.
 */

function showIABBanner() {
  if (document.getElementById('iab-banner')) return;

  var ua         = navigator.userAgent || '';
  var isAndroid  = /android/i.test(ua);
  var currentUrl = window.location.href;

  var banner = document.createElement('div');
  banner.id        = 'iab-banner';
  banner.className = 'iab-banner';
  banner.setAttribute('role', 'alert');

  var message = document.createElement('p');
  message.className   = 'iab-banner-msg';
  message.textContent = 'Paintings are not displaying in this browser. For the full experience, please open this page in Chrome or Safari.';

  var btnRow = document.createElement('div');
  btnRow.className = 'iab-banner-btns';

  if (isAndroid) {
    var intentUrl = 'intent://' + currentUrl.replace(/^https?:\/\//, '') + '#Intent;scheme=https;package=com.android.chrome;end';
    var openBtn   = document.createElement('a');
    openBtn.className   = 'iab-banner-btn iab-banner-btn-primary';
    openBtn.textContent = 'Open in Chrome';
    openBtn.href        = intentUrl;
    btnRow.appendChild(openBtn);
  } else {
    var copyBtn = document.createElement('button');
    copyBtn.className   = 'iab-banner-btn iab-banner-btn-primary';
    copyBtn.textContent = 'Copy link — open in Safari';
    copyBtn.addEventListener('click', function() {
      try {
        navigator.clipboard.writeText(currentUrl).then(function() {
          copyBtn.textContent = 'Copied! Now paste in Safari';
        });
      } catch (e) {
        copyBtn.textContent = currentUrl;
      }
    });
    btnRow.appendChild(copyBtn);
  }

  var dismissBtn = document.createElement('button');
  dismissBtn.className   = 'iab-banner-btn iab-banner-btn-dismiss';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', function() { banner.style.display = 'none'; });
  btnRow.appendChild(dismissBtn);

  banner.appendChild(message);
  banner.appendChild(btnRow);

  var body = document.body || document.documentElement;
  body.insertBefore(banner, body.firstChild);
}

// Banner only shows when gallery actually fails to load.
// showIABBanner() is called from loadArtworks() if artworks is empty.

/* ─── SESSION ─────────────────────────────────────────────────────────────── */
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
let newImgDataArray = [];
let squareCard      = null;
let squarePayments  = null;
let selectedPostage = null;        // AusPost quote — { name, price, quoteId } | null
let selectedGelatoPostage = null;  // Gelato print-shipping quote — { name, price, quoteId } | null
let artistPhoto     = null;

// Grouped-listing (Gelato size variants) state — maps printGroupId -> the
// artwork id of whichever size pill is currently "active" for that card.
let activeVariantByGroup = {};

/* ─── TASK 4 STATE — admin editing, reordering, collections ───────────────── */
let editingId        = null;   // artwork id currently being edited in the add/edit panel, or null when adding
let newCollections    = [];    // working list of collection-name chips for the add/edit panel
let existingImages    = [];    // (edit mode) image URLs currently on the record, minus any removed this session
let removedImageUrls  = [];    // (edit mode) URLs staged for removal, sent as removeImageUrls on save

// Public gallery collection filter — null means "All". Keyed by category
// so the two galleries filter independently of each other.
let activeCollectionFilter = { seascape: null, figurative: null };

// Lightbox state
let lightboxImages = [];
let lightboxIndex  = 0;
let lightboxTitle  = '';

/* ─── HELPER ──────────────────────────────────────────────────────────────── */
function el(id) {
  const element = document.getElementById(id);
  if (!element) console.warn('Element not found:', id);
  return element;
}

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
        errMsg = 'This image is too large (over 4MB). Please resize it and try again.';
      }
    }
    throw Object.assign(new Error(errMsg), { status: res.status });
  }
  return res.json();
}

/* ─── GALLERY ─────────────────────────────────────────────────────────────── */
async function loadArtworks() {
  try {
    const data  = await apiFetch('/api/get-artworks');
    artworks    = Array.isArray(data.artworks) ? data.artworks : [];
    artistPhoto = data.artistPhoto || null;
    renderArtistPhoto();
  } catch (e) {
    console.error('Failed to load artworks:', e);
    if (artworks.length === 0) artworks = [];
    artistPhoto = artistPhoto || null;
  }

  // Gallery-failure detection — show banner if nothing loaded
  if (artworks.length === 0) {
    showIABBanner();
  }
}

/* ─── ARTIST PHOTO ────────────────────────────────────────────────────────── */
function renderArtistPhoto() {
  try {
    const wrap     = el('about-photo');
    const label    = el('about-photo-label');
    if (!wrap) return;
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
  } catch (e) {
    console.error('renderArtistPhoto failed:', e);
  }
}

async function handleArtistPhotoUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const btn = el('artist-photo-upload-btn');
  btn.textContent = 'Uploading…'; btn.disabled = true;
  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      const data = await apiFetch('/api/update-artist-photo', {
        method: 'POST',
        body:   JSON.stringify({ imgData: ev.target.result }),
      });
      artistPhoto = data.imgUrl || ev.target.result;
      renderArtistPhoto();
    } catch (err) {
      alert('Failed to upload photo. Please try again.');
      console.error(err);
    } finally {
      btn.textContent = 'Change photo'; btn.disabled = false;
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

/* ─── GALLERY GROUPING (Gelato size variants) ─────────────────────────────── */

/**
 * Groups the artworks array by printGroupId. Items sharing a non-null
 * printGroupId are combined into one entry (an array of variant records,
 * ordered as they appear in `artworks`); every other item (printGroupId
 * null/absent) is emitted as its own single-item group, so the gallery
 * renderer only ever deals with one shape. Fully backwards compatible —
 * records without printGroupId render exactly as they always have.
 */
function groupArtworksByPrintGroup(items) {
  const groups = [];
  const byGroupId = {};
  items.forEach(art => {
    if (art && art.printGroupId) {
      let group = byGroupId[art.printGroupId];
      if (!group) { group = []; byGroupId[art.printGroupId] = group; groups.push(group); }
      group.push(art);
    } else if (art) {
      groups.push([art]);
    }
  });
  return groups;
}

/**
 * Returns the "active" artwork record for a group of size variants — the
 * one whose size pill is currently selected (tracked in
 * activeVariantByGroup, keyed by printGroupId). Falls back to the first
 * variant in the group if nothing has been chosen yet.
 */
function getActiveVariant(group) {
  if (group.length === 1) return group[0];
  const groupId  = group[0].printGroupId;
  const activeId = activeVariantByGroup[groupId];
  return group.find(a => a.id === activeId) || group[0];
}

/* ─── GALLERY CARDS ───────────────────────────────────────────────────────── */

/**
 * Builds a single gallery card for a group of one or more artwork
 * records (a group of >1 is a Gelato print offered in multiple sizes,
 * sharing one printGroupId — see groupArtworksByPrintGroup above).
 * The card's own DOM node is built once here; renderCardContent() (below)
 * fills in the content and is re-callable so a size-pill click can update
 * the card in place without re-rendering the whole gallery.
 */
function buildCard(group) {
  try {
    const first = group[0];
    const card = document.createElement('div');
    card.className = 'artwork-card';
    card.id = 'card-' + (first.printGroupId ? 'group-' + first.printGroupId : first.id);

    // data-ids lists every artwork id represented by this card (more
    // than one only for a grouped Gelato listing) — read back by
    // persistGalleryOrder() so a drag reorders a whole group together.
    card.dataset.ids = group.map(a => a.id).join(',');

    // Drag-and-drop reordering — admin only. Wired once here (not in
    // renderCardContent, which can re-run on a size-pill click) so a
    // card never accumulates duplicate listeners across re-renders.
    if (isAdmin) {
      card.draggable = true;
      card.addEventListener('dragstart', () => { card.classList.add('dragging'); });
      card.addEventListener('dragend', async () => {
        card.classList.remove('dragging');
        const gridEl = card.parentElement;
        if (gridEl) await persistGalleryOrder(gridEl);
      });
    }

    renderCardContent(card, group);
    return card;
  } catch (e) {
    console.error('buildCard failed for artwork group:', group && group[0] && group[0].id, e);
    return null;
  }
}

/**
 * Fills (or refills) a card's content from the group's currently active
 * variant. Called once when the card is first built, and again — on just
 * that card, not the whole gallery — whenever a size pill is clicked.
 *
 * Oversized paintings:
 *   - Show a gold "Contact Artist" link instead of the add-to-cart button
 *   - Cannot be added to the cart
 *   - CAN still be marked sold by the admin (e.g. once a freight sale is
 *     arranged manually) — the sold overlay and admin toggle behave the
 *     same as standard paintings.
 */
function renderCardContent(card, group) {
  const art = getActiveVariant(group);
  card.innerHTML = '';

  const imgWrap = document.createElement('div');
  imgWrap.className = 'artwork-img';

  const heroUrl = art.images && art.images.length > 0 ? art.images[0] : null;
  if (heroUrl) {
    const img = document.createElement('img');
    img.src = heroUrl; img.alt = art.title || '';
    img.onerror = () => { img.style.display = 'none'; };
    imgWrap.appendChild(img);
  } else if (art.svg) {
    imgWrap.innerHTML = art.svg;
  }

  if (heroUrl) imgWrap.addEventListener('click', () => openLightbox(art));

  if (art.images && art.images.length > 1) {
    const badge = document.createElement('span');
    badge.className   = 'artwork-img-count';
    badge.textContent = art.images.length + ' photos';
    imgWrap.appendChild(badge);
  }

  // Sold overlay — applies to all paintings, including oversized/freight ones
  if (art.sold) {
    const overlay = document.createElement('div');
    overlay.className = 'sold-overlay'; overlay.textContent = 'Sold';
    imgWrap.appendChild(overlay);
  }

  const labelRow = document.createElement('div'); labelRow.className = 'artwork-label';
  const titleEl  = document.createElement('span'); titleEl.className  = 'artwork-title'; titleEl.textContent = art.title || 'Untitled';
  const priceEl  = document.createElement('span'); priceEl.className  = 'artwork-price'; priceEl.textContent = 'AUD $' + (art.price || 0).toLocaleString();
  labelRow.appendChild(titleEl); labelRow.appendChild(priceEl);

  const mediumEl = document.createElement('div'); mediumEl.className = 'artwork-medium'; mediumEl.textContent = art.medium || '';

  card.appendChild(imgWrap); card.appendChild(labelRow); card.appendChild(mediumEl);

  // ── Size picker — only for grouped (multi-variant) Gelato listings ─────
  if (group.length > 1) {
    const picker = document.createElement('div');
    picker.className = 'size-picker';
    group.forEach(variant => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'size-pill' + (variant.id === art.id ? ' active' : '');
      pill.textContent = variant.variantLabel || 'Option';
      pill.addEventListener('click', () => {
        activeVariantByGroup[variant.printGroupId] = variant.id;
        renderCardContent(card, group);
      });
      picker.appendChild(pill);
    });
    card.appendChild(picker);
  }

  // ── Action button — differs for oversized vs standard ────────────────
  let actionEl;
  if (art.oversized) {
    if (art.sold) {
      // Sold oversized painting — show a disabled state, no link to contact
      actionEl = document.createElement('button');
      actionEl.className   = 'contact-artist-btn';
      actionEl.disabled    = true;
      actionEl.textContent = 'Sold';
    } else {
      actionEl = document.createElement('a');
      actionEl.className   = 'contact-artist-btn';
      actionEl.href        = '#contact';
      actionEl.textContent = 'Contact Artist — freight quote required';
    }
  } else {
    // Standard flow — used for both original paintings and Gelato prints.
    // "Add to selection" on a grouped card adds whichever variant is
    // currently active; from here on the cart treats it as an ordinary
    // single artwork (Decision 2, Part 5.1) — no size-aware cart logic.
    actionEl = document.createElement('button');
    actionEl.className   = 'add-btn' + (inCart(art.id) ? ' added' : '');
    actionEl.disabled    = art.sold || inCart(art.id);
    actionEl.textContent = art.sold ? 'Sold' : inCart(art.id) ? 'In your selection' : '+ Add to selection';
    actionEl.addEventListener('click', () => addToCart(art.id));
  }

  // ── Admin controls ───────────────────────────────────────────────────
  const adminCtrl = document.createElement('div');
  adminCtrl.className = 'admin-controls' + (isAdmin ? ' visible' : '');

  const soldBtn = document.createElement('button');
  soldBtn.className = 'admin-ctrl-btn sold-toggle';
  soldBtn.textContent = art.sold ? 'Mark available' : 'Mark sold';
  // Sold toggle is always enabled — oversized paintings can be marked
  // sold by the admin once a freight sale is arranged manually, and
  // Gelato prints can be manually discontinued the same way (Decision 4,
  // Part 5.1) even though a purchase never auto-marks them sold.
  soldBtn.addEventListener('click', () => toggleSold(art.id));

  const editBtn = document.createElement('button');
  editBtn.className = 'admin-ctrl-btn edit-btn'; editBtn.textContent = 'Edit';
  // Edits whichever variant is currently active on this card — for a
  // grouped listing, click that size's pill first to edit a different one.
  editBtn.addEventListener('click', () => openEditPanel(art));

  const delBtn = document.createElement('button');
  delBtn.className = 'admin-ctrl-btn del'; delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', () => confirmDelete(art.id, art.title));

  adminCtrl.appendChild(editBtn); adminCtrl.appendChild(soldBtn); adminCtrl.appendChild(delBtn);

  card.appendChild(actionEl); card.appendChild(adminCtrl);
}

function populateGrid(gridEl, groups) {
  if (!gridEl) return;
  gridEl.innerHTML = '';
  if (!groups || groups.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'gallery-empty'; empty.textContent = 'No works in this collection yet.';
    gridEl.appendChild(empty); return;
  }
  const frag = document.createDocumentFragment();
  let built = 0;
  groups.forEach(group => {
    const card = buildCard(group);
    if (card) { frag.appendChild(card); built++; }
  });
  if (built === 0) {
    const empty = document.createElement('p');
    empty.className = 'gallery-empty'; empty.textContent = 'No works in this collection yet.';
    gridEl.appendChild(empty);
  } else {
    gridEl.appendChild(frag);
  }
}

/**
 * Sorts a category's artworks by their `order` field ascending, falling
 * back to `id` (a creation timestamp) for any record that predates the
 * order field — which sorts it exactly where it already renders today,
 * so no migration is needed for existing listings. Group position for a
 * multi-variant Gelato card is decided by whichever of its variants sorts
 * earliest, since grouping (below) runs over this already-sorted array.
 */
function sortByOrder(items) {
  return [...items].sort((a, b) => (a.order ?? a.id ?? 0) - (b.order ?? b.id ?? 0));
}

/**
 * Applies the active collection filter (if any) for one category. A
 * grouped card is kept if ANY of its variants carry the active
 * collection, so filtering happens on the flat item list before grouping.
 */
function filterByActiveCollection(category, items) {
  const active = activeCollectionFilter[category];
  if (!active) return items;
  return items.filter(a => Array.isArray(a.collections) && a.collections.includes(active));
}

/**
 * Renders the "All" + one-pill-per-collection filter bar above a
 * category's gallery grid, computed from whatever collection names
 * actually appear among that category's CURRENT listings (not filtered —
 * the bar itself always shows every available option). Hides the whole
 * bar when no listing in the category has a collection assigned.
 */
// Filter-bar element ids don't follow a uniform plural rule (matching the
// pre-existing #gallery-seascapes / #gallery-figurative asymmetry in
// index.html), so map explicitly rather than string-concatenating.
const COLLECTIONS_FILTER_BAR_IDS = {
  seascape:   'collections-filter-seascapes',
  figurative: 'collections-filter-figurative',
};

function renderCollectionsFilterBar(category, items) {
  const barEl = el(COLLECTIONS_FILTER_BAR_IDS[category]);
  if (!barEl) return;

  const names = new Set();
  items.forEach(a => (a.collections || []).forEach(c => names.add(c)));

  if (names.size === 0) {
    barEl.classList.add('hidden');
    barEl.innerHTML = '';
    activeCollectionFilter[category] = null;
    return;
  }

  // If the previously active filter no longer exists in this category
  // (e.g. the last painting carrying it was edited/deleted), fall back
  // to "All" rather than showing an empty gallery silently.
  if (activeCollectionFilter[category] && !names.has(activeCollectionFilter[category])) {
    activeCollectionFilter[category] = null;
  }

  barEl.classList.remove('hidden');
  barEl.innerHTML = '';

  const active = activeCollectionFilter[category];
  const makePill = (label, value) => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'collection-pill' + (active === value ? ' active' : '');
    pill.textContent = label;
    pill.addEventListener('click', () => {
      activeCollectionFilter[category] = value;
      renderGallery();
    });
    return pill;
  };

  barEl.appendChild(makePill('All', null));
  Array.from(names).sort((a, b) => a.localeCompare(b)).forEach(name => barEl.appendChild(makePill(name, name)));
}

function renderGallery() {
  try {
    const seascapes  = artworks.filter(a => a && a.category === 'seascape');
    const figurative = artworks.filter(a => a && (a.category === 'figurative' || !a.category));

    renderCollectionsFilterBar('seascape',   seascapes);
    renderCollectionsFilterBar('figurative', figurative);

    const seascapesShown   = sortByOrder(filterByActiveCollection('seascape',   seascapes));
    const figurativeShown  = sortByOrder(filterByActiveCollection('figurative', figurative));

    populateGrid(el('gallery-seascapes'),  groupArtworksByPrintGroup(seascapesShown));
    populateGrid(el('gallery-figurative'), groupArtworksByPrintGroup(figurativeShown));
  } catch (e) {
    console.error('renderGallery failed:', e);
  }
}

function inCart(id) { return cart.some(i => i.id === id); }

/**
 * Inspects the cart and returns which fulfilment domains it contains —
 * 'auspost' for standard/oversized-original items shipped by Michael,
 * 'gelato' for Gelato print-on-demand items. Used to decide which of the
 * two postage UI blocks to show, and to validate that a postage
 * selection exists for each domain before allowing payment.
 */
function getCartSources() {
  const sources = new Set();
  cart.forEach(a => sources.add(a && a.source === 'gelato' ? 'gelato' : 'auspost'));
  return sources;
}

/* ─── DRAG-AND-DROP REORDERING (admin only) ───────────────────────────────── */

/**
 * Finds which card in a grid the dragged card should be placed next to,
 * given the pointer's current position — by nearest card center, since
 * the gallery is a wrapping 2D grid rather than a single column (the
 * usual "closest by Y" drag-reorder trick only works for 1D lists).
 * Returns { element, after } — after=true means insert following that
 * card, after=false means insert before it.
 */
function getDragAfterElement(container, x, y) {
  const cards = [...container.querySelectorAll('.artwork-card:not(.dragging)')];
  let closest = { distance: Infinity, element: null, after: false };
  cards.forEach(card => {
    const box = card.getBoundingClientRect();
    const cx  = box.left + box.width / 2;
    const cy  = box.top  + box.height / 2;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < closest.distance) closest = { distance: dist, element: card, after: x > cx };
  });
  return closest;
}

/**
 * Live-reorders the DOM while a card is being dragged across the grid —
 * called from the grid's own dragover listener (wired once at boot, see
 * the DOMContentLoaded handler below). The actual save to the server
 * happens once, on that card's dragend (see buildCard).
 */
function handleGalleryDragOver(e, gridEl) {
  const dragging = gridEl.querySelector('.artwork-card.dragging');
  if (!dragging) return;
  e.preventDefault();
  const { element: target, after } = getDragAfterElement(gridEl, e.clientX, e.clientY);
  if (!target || target === dragging) return;
  if (after) target.after(dragging); else target.before(dragging);
}

/**
 * Reads the grid's current DOM order and saves it via
 * PATCH /api/paintings { action: 'reorder' }. Each card can represent a
 * group of Gelato size variants (see buildCard's data-ids attribute) —
 * every id in a group is sent in sequence at that card's position, so
 * the whole group moves together and keeps sorting as one unit.
 */
async function persistGalleryOrder(gridEl) {
  const ids = [];
  gridEl.querySelectorAll('.artwork-card').forEach(card => {
    (card.dataset.ids || '').split(',').filter(Boolean).forEach(idStr => ids.push(Number(idStr)));
  });
  if (ids.length === 0) return;
  try {
    await apiFetch('/api/paintings', { method: 'PATCH', body: JSON.stringify({ action: 'reorder', order: ids }) });
    await loadArtworks();
    renderGallery();
  } catch (e) {
    console.error('Reorder failed:', e);
    alert('Could not save the new order. Please try again.');
    await loadArtworks();
    renderGallery(); // revert the DOM to whatever the server actually has
  }
}

/* ─── LIGHTBOX ────────────────────────────────────────────────────────────── */
function openLightbox(art, startIdx = 0) {
  try {
    if (!art.images || art.images.length === 0) return;
    lightboxImages = art.images;
    lightboxIndex  = startIdx;
    lightboxTitle  = art.title;

    const dotsEl = el('lightbox-dots');
    dotsEl.innerHTML = '';
    art.images.forEach((_, i) => {
      const dot = document.createElement('button');
      dot.className = 'lightbox-dot' + (i === startIdx ? ' active' : '');
      dot.setAttribute('aria-label', 'Image ' + (i + 1));
      dot.addEventListener('click', () => showLightboxImage(i));
      dotsEl.appendChild(dot);
    });

    const hasMult = art.images.length > 1;
    el('lightbox-prev').classList.toggle('hidden', !hasMult);
    el('lightbox-next').classList.toggle('hidden', !hasMult);
    el('lightbox-title').textContent = art.title;
    el('lightbox-img').src = art.images[startIdx];
    el('lightbox-img').alt = art.title;
    updateLightboxCounter();
    updateLightboxNavButtons();
    el('lightbox-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
  } catch (e) {
    console.error('openLightbox failed:', e);
  }
}

function closeLightbox() {
  try {
    el('lightbox-overlay').classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(() => {
      const img = el('lightbox-img');
      if (img) img.src = '';
      lightboxImages = [];
    }, 250);
  } catch (e) { console.error('closeLightbox failed:', e); }
}

function showLightboxImage(idx) {
  if (idx < 0 || idx >= lightboxImages.length) return;
  lightboxIndex = idx;
  const imgEl = el('lightbox-img');
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

function lightboxNext() { if (lightboxIndex < lightboxImages.length - 1) showLightboxImage(lightboxIndex + 1); }
function lightboxPrev() { if (lightboxIndex > 0) showLightboxImage(lightboxIndex - 1); }

function updateLightboxCounter() {
  const total = lightboxImages.length;
  el('lightbox-counter').textContent = total > 1 ? (lightboxIndex + 1) + ' of ' + total : '';
}
function updateLightboxDots() {
  el('lightbox-dots').querySelectorAll('.lightbox-dot')
    .forEach((dot, i) => dot.classList.toggle('active', i === lightboxIndex));
}
function updateLightboxNavButtons() {
  el('lightbox-prev').disabled = lightboxIndex === 0;
  el('lightbox-next').disabled = lightboxIndex === lightboxImages.length - 1;
}

/* ─── ADMIN AUTH ──────────────────────────────────────────────────────────── */
function openLogin() {
  el('admin-pw').value = ''; el('login-error').textContent = '';
  el('login-overlay').classList.add('open');
  setTimeout(() => el('admin-pw').focus(), 200);
}
function closeLogin() {
  el('login-overlay').classList.remove('open');
  el('admin-pw').type = 'password'; el('pw-toggle-btn').textContent = 'Show';
}

async function attemptLogin() {
  const pw = el('admin-pw').value; const btnEl = el('login-btn');
  if (!pw) { el('login-error').textContent = 'Please enter your password.'; return; }
  btnEl.disabled = true; btnEl.textContent = 'Signing in…';
  try {
    const data = await apiFetch('/api/login', { method: 'POST', body: JSON.stringify({ password: pw }) });
    setToken(data.token); isAdmin = true; closeLogin(); activateAdminMode();
  } catch (e) {
    const msg =
      e.status === 401 ? 'Incorrect password.' :
      e.status === 403 ? 'Login blocked. Ensure ALLOWED_ORIGIN is set in Vercel.' :
      e.status === 429 ? (e.message || 'Too many attempts. Please wait before trying again.') :
      'Login failed. Please try again.';
    el('login-error').textContent = msg;
    el('admin-pw').value = '';
    setTimeout(() => el('admin-pw').focus(), 50);
  } finally { btnEl.disabled = false; btnEl.textContent = 'Sign in'; }
}

async function adminLogout() {
  try { await apiFetch('/api/logout', { method: 'POST', body: JSON.stringify({}) }); }
  catch (e) { console.error('Server logout failed:', e); }
  clearToken(); isAdmin = false;
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
    await loadArtworks(); renderGallery(); updateCartUI();
  } catch (e) { console.error('toggleSold failed:', e); alert('Could not update status. Please try again.'); }
}

function confirmDelete(id, title) {
  pendingDeleteId = id;
  el('confirm-sub').textContent = '"' + title + '" will be removed from your gallery permanently.';
  el('confirm-overlay').classList.add('open');
}
function closeConfirm() { el('confirm-overlay').classList.remove('open'); }

async function executeDeletion() {
  if (!pendingDeleteId) return;
  const id = pendingDeleteId; pendingDeleteId = null;
  el('confirm-overlay').classList.remove('open');
  try {
    await apiFetch('/api/paintings', { method: 'DELETE', body: JSON.stringify({ id }) });
    cart = cart.filter(i => i.id !== id);
    await loadArtworks(); renderGallery(); updateCartUI();
  } catch (e) { console.error('delete failed:', e); alert('Could not delete painting. Please try again.'); }
}

/* ─── ADD PAINTING ────────────────────────────────────────────────────────── */
function renderImgStrip() {
  const strip   = el('img-strip');
  const addWrap = el('img-strip-add');
  if (!strip || !addWrap) return;
  strip.innerHTML = '';

  newImgDataArray.forEach((dataUri, i) => {
    const tile = document.createElement('div'); tile.className = 'img-strip-thumb';
    const img  = document.createElement('img'); img.src = dataUri; img.alt = 'Image ' + (i + 1);
    tile.appendChild(img);
    const removeBtn = document.createElement('button');
    removeBtn.className = 'img-strip-remove'; removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', 'Remove image ' + (i + 1));
    removeBtn.addEventListener('click', () => { newImgDataArray.splice(i, 1); renderImgStrip(); });
    tile.appendChild(removeBtn);
    strip.appendChild(tile);
  });

  addWrap.style.display = newImgDataArray.length >= 10 ? 'none' : '';
}

/**
 * Renders the "current photos" strip shown only in edit mode
 * (existingImages, populated by openEditPanel) — separate from
 * renderImgStrip()'s NEW-photo previews above, since removing an
 * already-uploaded image (staged into removedImageUrls) and adding a new
 * one are different operations sent to different endpoints on save.
 */
function renderExistingImgStrip() {
  const strip = el('existing-img-strip');
  if (!strip) return;
  strip.innerHTML = '';

  existingImages.forEach((url, i) => {
    const tile = document.createElement('div'); tile.className = 'img-strip-thumb';
    const img  = document.createElement('img'); img.src = url; img.alt = 'Existing image ' + (i + 1);
    img.onerror = () => { img.style.display = 'none'; };
    tile.appendChild(img);
    const removeBtn = document.createElement('button');
    removeBtn.className = 'img-strip-remove'; removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', 'Remove existing image ' + (i + 1));
    removeBtn.addEventListener('click', () => {
      removedImageUrls.push(url);
      existingImages.splice(i, 1);
      renderExistingImgStrip();
    });
    tile.appendChild(removeBtn);
    strip.appendChild(tile);
  });
}

/**
 * Renders the collections chip row from the working newCollections[]
 * array, each with its own remove (×) — the same tile-plus-remove-button
 * pattern already used for the image strips above.
 */
function renderCollectionsChips() {
  const wrap = el('collections-chips');
  if (!wrap) return;
  wrap.innerHTML = '';

  newCollections.forEach((name, i) => {
    const chip = document.createElement('span'); chip.className = 'collection-chip';
    const label = document.createElement('span'); label.textContent = name;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button'; removeBtn.className = 'collection-chip-remove'; removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', 'Remove collection ' + name);
    removeBtn.addEventListener('click', () => { newCollections.splice(i, 1); renderCollectionsChips(); });
    chip.appendChild(label); chip.appendChild(removeBtn);
    wrap.appendChild(chip);
  });
}

/** Adds whatever's typed in #new-collection-input as a chip (Enter or the Add button). */
function addCollectionFromInput() {
  const input = el('new-collection-input');
  const errEl = el('add-error');
  const name  = input.value.trim();
  if (!name) return;
  if (name.length > 40) { errEl.textContent = 'Collection names must be 40 characters or fewer.'; return; }
  if (newCollections.length >= 20) { errEl.textContent = 'A painting can belong to at most 20 collections.'; return; }
  if (!newCollections.includes(name)) newCollections.push(name);
  input.value = '';
  errEl.textContent = '';
  renderCollectionsChips();
}

/**
 * Reads which "Listing type" radio is currently selected and returns its
 * value: 'original' | 'oversized' | 'gelato'. Defaults to 'original' if
 * for some reason nothing is checked.
 */
function getSelectedListingType() {
  const checked = document.querySelector('input[name="listing-type"]:checked');
  return checked ? checked.value : 'original';
}

/**
 * Shows/hides the shipping-dimensions block and the Gelato-only field
 * group based on the selected listing type. Generalises/replaces the old
 * updateOversizedToggle() — #shipping-dimensions is reused exactly as
 * before, now hidden for BOTH "Oversized" and "Gelato print", shown only
 * for "Original".
 */
function updateListingTypeToggle() {
  const type       = getSelectedListingType();
  const dimensions = el('shipping-dimensions');
  const gelato     = el('gelato-fields');
  if (dimensions) dimensions.classList.toggle('hidden', type !== 'original');
  if (gelato)     gelato.classList.toggle('hidden', type !== 'gelato');
}

function openAddPanel() {
  editingId = null;
  el('add-panel-title').textContent     = 'Add a painting';
  el('save-painting-btn').textContent   = 'Save painting to gallery';
  el('existing-images-section').classList.add('hidden');
  existingImages = []; removedImageUrls = [];
  el('existing-img-strip').innerHTML = '';

  el('add-panel').classList.add('open');
  document.body.style.overflow = 'hidden';

  ['new-title', 'new-medium', 'new-price',
   'new-weight', 'new-length', 'new-width', 'new-height',
   'new-gelato-uid', 'new-print-group', 'new-variant-label'].forEach(id => {
    const field = el(id);
    if (field) field.value = '';
  });
  el('new-category').value    = 'seascape';
  el('new-sold').checked      = false;
  el('listing-type-original').checked = true;
  el('add-error').textContent = '';
  el('gelato-import-message').textContent = '';
  el('gelato-import-results').innerHTML   = '';

  updateListingTypeToggle();

  newCollections = [];
  renderCollectionsChips();
  el('new-collection-input').value = '';

  newImgDataArray = []; renderImgStrip(); el('img-file').value = '';
}

/**
 * Opens the same add-panel markup in "edit" mode, pre-filled from an
 * existing artwork record — the most natural place to start Task 4 per
 * the project summary, since paintings.js's PUT handler already existed
 * and just needed a UI that calls it. `art` is the currently active
 * variant of whichever card's Edit button was clicked (see
 * renderCardContent) — editing a different size variant of a grouped
 * listing means selecting its size pill first.
 */
function openEditPanel(art) {
  editingId = art.id;
  el('add-panel-title').textContent   = 'Edit painting';
  el('save-painting-btn').textContent = 'Save changes';

  el('add-panel').classList.add('open');
  document.body.style.overflow = 'hidden';

  el('new-title').value    = art.title  || '';
  el('new-medium').value   = art.medium || '';
  el('new-price').value    = art.price != null ? art.price : '';
  el('new-category').value = art.category === 'figurative' ? 'figurative' : 'seascape';
  el('new-sold').checked   = !!art.sold;
  el('add-error').textContent = '';

  const type = art.source === 'gelato' ? 'gelato' : (art.oversized ? 'oversized' : 'original');
  el('listing-type-' + type).checked = true;

  if (art.shipping) {
    el('new-weight').value = art.shipping.weight ?? '';
    el('new-length').value = art.shipping.length ?? '';
    el('new-width').value  = art.shipping.width  ?? '';
    el('new-height').value = art.shipping.height ?? '';
  } else {
    ['new-weight', 'new-length', 'new-width', 'new-height'].forEach(id => { el(id).value = ''; });
  }

  el('new-gelato-uid').value    = art.gelatoProductUid || '';
  el('new-print-group').value   = art.printGroupId     || '';
  el('new-variant-label').value = art.variantLabel     || '';
  el('gelato-import-message').textContent = '';
  el('gelato-import-results').innerHTML   = '';

  updateListingTypeToggle();

  newCollections = Array.isArray(art.collections) ? [...art.collections] : [];
  renderCollectionsChips();
  el('new-collection-input').value = '';

  existingImages   = Array.isArray(art.images) && art.images.length > 0
    ? [...art.images]
    : (art.imgUrl ? [art.imgUrl] : []);
  removedImageUrls = [];
  renderExistingImgStrip();
  el('existing-images-section').classList.remove('hidden');

  newImgDataArray = []; renderImgStrip(); el('img-file').value = '';
}

function closeAddPanel() {
  el('add-panel').classList.remove('open');
  document.body.style.overflow = '';
  editingId = null;
}

function handleImgUpload(e) {
  const files = Array.from(e.target.files); if (!files.length) return;
  const remaining = 10 - newImgDataArray.length;
  const toLoad    = files.slice(0, remaining);
  el('add-error').textContent = files.length > remaining
    ? 'Maximum 10 images per painting — ' + (files.length - remaining) + ' file(s) were not added.'
    : '';
  let loaded = 0;
  toLoad.forEach(file => {
    const reader = new FileReader();
    reader.onload = ev => {
      newImgDataArray.push(ev.target.result); loaded++;
      if (loaded === toLoad.length) renderImgStrip();
    };
    reader.readAsDataURL(file);
  });
  e.target.value = '';
}

/**
 * Fetches Michael's connected Gelato store's product/variant list
 * (GET /api/paintings, admin-only) and renders it as a clickable list so
 * he can fill the Product UID field without copy-pasting it manually.
 *
 * If Gelato isn't configured (no GELATO_STORE_ID), the endpoint responds
 * with success: false and a message — per the graceful-degradation design
 * (Part 5.2), this is shown inline as normal, expected text, not an error
 * state. Manual Product UID entry always remains available regardless.
 */
async function importFromGelato() {
  const btn      = el('gelato-import-btn');
  const msgEl    = el('gelato-import-message');
  const resultsEl = el('gelato-import-results');
  if (!btn || !msgEl || !resultsEl) return;

  btn.disabled = true; btn.textContent = 'Importing…';
  msgEl.textContent = '';
  resultsEl.innerHTML = '';

  try {
    const data = await apiFetch('/api/paintings');

    if (data.success === false) {
      msgEl.textContent = data.error || 'Gelato import is not available right now — enter the Product UID manually.';
      return;
    }

    const products = Array.isArray(data.products) ? data.products : [];
    if (products.length === 0) {
      msgEl.textContent = 'No Gelato products found for this store.';
      return;
    }

    const frag = document.createDocumentFragment();
    products.forEach(p => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'gelato-import-item';
      const titleSpan = document.createElement('span');
      titleSpan.className = 'gelato-import-item-title';
      titleSpan.textContent = [p.productTitle, p.variantTitle].filter(Boolean).join(' — ') || 'Untitled product';
      const uidSpan = document.createElement('span');
      uidSpan.className = 'gelato-import-item-uid';
      uidSpan.textContent = p.productUid || '';
      item.appendChild(titleSpan); item.appendChild(uidSpan);

      item.addEventListener('click', () => {
        el('new-gelato-uid').value = p.productUid || '';
        const titleField = el('new-title');
        if (titleField && !titleField.value.trim()) {
          titleField.value = [p.productTitle, p.variantTitle].filter(Boolean).join(' — ');
        }
      });
      frag.appendChild(item);
    });
    resultsEl.appendChild(frag);

  } catch (e) {
    msgEl.textContent = e.message || 'Could not fetch Gelato products. Please try again, or enter the Product UID manually.';
  } finally {
    btn.disabled = false; btn.textContent = 'Import from Gelato';
  }
}

/**
 * Handles both the Add and Edit flows — the same panel, form fields, and
 * validation are shared; only the request (POST vs PUT) and a few
 * edit-only fields (id, removeImageUrls) differ. editingId (set by
 * openEditPanel, cleared by openAddPanel/closeAddPanel) is what tells
 * this function which mode it's in.
 */
async function saveNewPainting() {
  const isEdit      = editingId !== null;
  const title       = el('new-title').value.trim();
  const medium      = el('new-medium').value.trim();
  const priceRaw    = el('new-price').value;
  const category    = el('new-category').value;
  const sold        = el('new-sold').checked;
  const listingType = getSelectedListingType(); // 'original' | 'oversized' | 'gelato'
  const oversized   = listingType === 'oversized';
  const isGelato    = listingType === 'gelato';
  const errEl       = el('add-error');
  const btn         = el('save-painting-btn');
  const savedLabel  = isEdit ? 'Save changes' : 'Save painting to gallery';

  if (!title)  { errEl.textContent = 'Please enter a title.'; return; }
  if (!medium) { errEl.textContent = 'Please enter the medium and dimensions.'; return; }
  const price = parseInt(priceRaw, 10);
  if (!priceRaw || isNaN(price) || price < 0) { errEl.textContent = 'Please enter a valid price.'; return; }

  let gelatoProductUid, printGroupId, variantLabel;
  if (isGelato) {
    gelatoProductUid = el('new-gelato-uid').value.trim();
    printGroupId     = el('new-print-group').value.trim() || null;
    variantLabel     = el('new-variant-label').value.trim() || null;
    if (!gelatoProductUid) { errEl.textContent = 'Please enter or import a Gelato Product UID.'; return; }
  }

  let weight, length, width, height;
  if (!oversized && !isGelato) {
    weight = parseFloat(el('new-weight').value);
    length = parseFloat(el('new-length').value);
    width  = parseFloat(el('new-width').value);
    height = parseFloat(el('new-height').value);
    if (isNaN(weight) || weight <= 0) { errEl.textContent = 'Please enter the packed weight in kg.'; return; }
    if (isNaN(length) || length <= 0) { errEl.textContent = 'Please enter the packed length in cm.'; return; }
    if (isNaN(width)  || width  <= 0) { errEl.textContent = 'Please enter the packed width in cm.'; return; }
    if (isNaN(height) || height <= 0) { errEl.textContent = 'Please enter the packed height in cm.'; return; }
  }

  errEl.textContent = '';
  btn.disabled = true; btn.textContent = 'Saving…';

  const body = {
    title, medium, price, category, sold, oversized,
    source: isGelato ? 'gelato' : 'original',
    collections: newCollections,
  };
  if (isGelato) {
    body.gelatoProductUid = gelatoProductUid;
    body.printGroupId     = printGroupId;
    body.variantLabel     = variantLabel;
    // Weight/length/width/height are intentionally omitted — Gelato
    // handles its own print shipping regardless of size (Part 5.3).
  } else if (!oversized) {
    body.weight = weight; body.length = length; body.width = width; body.height = height;
  }

  let targetId;
  try {
    if (isEdit) {
      body.id              = editingId;
      body.removeImageUrls = removedImageUrls;
      await apiFetch('/api/paintings', { method: 'PUT', body: JSON.stringify(body) });
      targetId = editingId;
    } else {
      const data = await apiFetch('/api/paintings', { method: 'POST', body: JSON.stringify(body) });
      targetId = data.id;
    }
  } catch (e) {
    errEl.textContent = e.message || 'Failed to save painting. Please try again.';
    btn.disabled = false; btn.textContent = savedLabel; return;
  }

  const total = newImgDataArray.length;
  const failedImages = [];
  for (let i = 0; i < total; i++) {
    btn.textContent = 'Uploading image ' + (i + 1) + ' of ' + total + '…';
    try {
      await apiFetch('/api/upload-image', {
        method: 'POST',
        body:   JSON.stringify({ artworkId: targetId, imgData: newImgDataArray[i], index: i }),
      });
    } catch (e) {
      failedImages.push({ index: i + 1, reason: e.message || 'Unknown error' });
      console.error('Image ' + (i + 1) + ' upload failed:', e);
    }
  }

  await loadArtworks();
  renderGallery();

  if (failedImages.length === 0) {
    closeAddPanel();
    if (!isEdit) {
      setTimeout(() => {
        const card = document.getElementById('card-' + targetId);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 200);
    }
  } else {
    const failList = failedImages.map(f => 'Image ' + f.index + ': ' + f.reason).join('\n');
    errEl.textContent =
      (isEdit ? 'Changes saved, but ' : 'Painting saved, but ') + failedImages.length + ' image(s) failed to upload:\n' + failList + '\n' +
      (isEdit ? 'You can try adding them again from the edit panel.' : 'The painting has been added to your gallery. You can delete and re-add it to retry the images.');
    btn.disabled = false; btn.textContent = savedLabel;
  }
}

/* ─── CART ────────────────────────────────────────────────────────────────── */
function addToCart(id) {
  const art = artworks.find(a => a.id === id);
  if (!art || art.sold || art.oversized || inCart(id)) return;
  cart.push(art); updateCartUI(); renderGallery(); openCart();
}
function removeFromCart(id) {
  cart = cart.filter(i => i.id !== id);
  updateCartUI(); renderGallery();
}

function updateCartUI() {
  try {
    const count = cart.length;
    el('cart-count').textContent = count;
    el('checkout-btn').disabled  = count === 0;
    const total = cart.reduce((s, i) => s + i.price, 0);
    el('cart-total').textContent = 'AUD $' + total.toLocaleString();

    const itemsEl = el('cart-items');
    const emptyEl = el('cart-empty');

    if (count === 0) {
      itemsEl.innerHTML = ''; itemsEl.appendChild(emptyEl);
      emptyEl.style.display = 'block'; return;
    }

    emptyEl.style.display = 'none';
    const frag = document.createDocumentFragment();
    frag.appendChild(emptyEl);

    cart.forEach(art => {
      const item  = document.createElement('div'); item.className = 'cart-item';
      const thumb = document.createElement('div'); thumb.className = 'cart-item-thumb';
      const heroUrl = art.images && art.images.length > 0 ? art.images[0] : null;
      if (heroUrl) {
        const img = document.createElement('img'); img.src = heroUrl; img.alt = art.title;
        img.onerror = () => { img.style.display = 'none'; };
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

    itemsEl.innerHTML = ''; itemsEl.appendChild(frag);
  } catch (e) { console.error('updateCartUI failed:', e); }
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

/**
 * Appends one postage line to the order summary — used twice below, once
 * for the AusPost slot and once for the Gelato slot, so a mixed cart
 * shows exactly what's being charged for each fulfilment path (Decision 1,
 * Part 5.1) rather than one merged "Postage" line. Only rendered for a
 * domain the cart actually needs (per getCartSources()).
 */
function appendPostageLine(summaryEl, quote, pendingLabel) {
  const row   = document.createElement('div'); row.className = 'order-line';
  const label = document.createElement('span');
  label.textContent = quote ? quote.name : pendingLabel;
  if (!quote) label.style.color = 'var(--gold)';
  const price = document.createElement('span');
  price.textContent = quote ? 'AUD $' + quote.price.toFixed(2) : '—';
  row.appendChild(label); row.appendChild(price);
  summaryEl.appendChild(row);
}

function buildOrderSummary() {
  const artworkTotal = cart.reduce((s, i) => s + i.price, 0);
  const sources       = getCartSources();
  const postageTotal  = (sources.has('auspost') && selectedPostage ? selectedPostage.price : 0) +
                        (sources.has('gelato')  && selectedGelatoPostage ? selectedGelatoPostage.price : 0);
  const grandTotal    = artworkTotal + postageTotal;
  const summaryEl     = el('order-summary');
  summaryEl.innerHTML = '';

  cart.forEach(a => {
    const row = document.createElement('div'); row.className = 'order-line';
    const nameSpan = document.createElement('span');
    const em = document.createElement('em'); em.textContent = a.title;
    nameSpan.appendChild(em);
    const priceSpan = document.createElement('span'); priceSpan.textContent = 'AUD $' + a.price.toLocaleString();
    row.appendChild(nameSpan); row.appendChild(priceSpan);
    summaryEl.appendChild(row);
  });

  if (sources.has('auspost')) appendPostageLine(summaryEl, selectedPostage, 'Standard Postage (select below)');
  if (sources.has('gelato'))  appendPostageLine(summaryEl, selectedGelatoPostage, 'Print Shipping (select below)');

  const totalRow = document.createElement('div'); totalRow.className = 'order-line total';
  totalRow.innerHTML = '<strong>Total</strong><strong>AUD $' + grandTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</strong>';
  summaryEl.appendChild(totalRow);
}

function updateOrderSummary() { buildOrderSummary(); }

/**
 * Shows/hides the "Print Shipping" (Gelato) postage block based on
 * whether the cart currently contains a Gelato item. Called whenever
 * checkout opens and whenever the destination country changes.
 */
function updateGelatoPostageVisibility() {
  const section = el('gelato-postage-section');
  if (section) section.classList.toggle('hidden', !getCartSources().has('gelato'));
}

async function openCheckout() {
  closeCart(); document.body.style.overflow = 'hidden';
  buildOrderSummary();
  el('checkout-modal').classList.add('open');
  el('checkout-body').style.display = 'block';
  el('success-state').style.display = 'none';
  updateGelatoPostageVisibility();
  updatePostageSectionForCountry();
  if (!squareCard) await initSquare();
}
function closeCheckout() {
  el('checkout-modal').classList.remove('open');
  el('postage-result').innerHTML = '';
  el('gelato-postage-result').innerHTML = '';
  el('buyer-postcode').value    = '';
  selectedPostage = null;
  selectedGelatoPostage = null;
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
    if (orders.length === 0) { body.innerHTML = '<div class="orders-empty">No orders yet.</div>'; return; }

    const frag = document.createDocumentFragment();
    orders.forEach(order => {
      const card = document.createElement('div'); card.className = 'order-card';
      const head = document.createElement('div'); head.className = 'order-card-head';
      const idEl = document.createElement('span'); idEl.className = 'order-card-id'; idEl.textContent = 'Order ' + order.orderId;
      const dateEl = document.createElement('span'); dateEl.className = 'order-card-date';
      dateEl.textContent = order.ts
        ? new Date(order.ts).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '—';
      head.appendChild(idEl); head.appendChild(dateEl);

      const cardBody = document.createElement('div'); cardBody.className = 'order-card-body';
      const worksLabel = document.createElement('div'); worksLabel.className = 'order-section-label'; worksLabel.textContent = 'Works Sold';
      cardBody.appendChild(worksLabel);
      (order.items || []).forEach(item => {
        const row = document.createElement('div'); row.className = 'order-item-row';
        const t = document.createElement('span'); t.className = 'order-item-title'; t.textContent = item.title;
        const p = document.createElement('span'); p.className = 'order-item-price'; p.textContent = 'AUD $' + Number(item.price).toLocaleString();
        row.appendChild(t); row.appendChild(p); cardBody.appendChild(row);
      });

      const postageRow = document.createElement('div'); postageRow.className = 'order-postage-row';
      const pl = document.createElement('span'); pl.textContent = order.postageName || 'Postage';
      const pp = document.createElement('span'); pp.textContent = 'AUD $' + Number(order.postagePrice).toFixed(2);
      postageRow.appendChild(pl); postageRow.appendChild(pp); cardBody.appendChild(postageRow);

      const totalRow = document.createElement('div'); totalRow.className = 'order-total-row';
      const tl = document.createElement('span'); tl.className = 'order-total-label'; tl.textContent = 'Total Charged';
      const ta = document.createElement('span'); ta.className = 'order-total-amount'; ta.textContent = 'AUD $' + Number(order.grandTotal).toFixed(2);
      totalRow.appendChild(tl); totalRow.appendChild(ta); cardBody.appendChild(totalRow);

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

      card.appendChild(head); card.appendChild(cardBody); frag.appendChild(card);
    });

    el('orders-panel-body').innerHTML = '';
    el('orders-panel-body').appendChild(frag);
  } catch (e) {
    el('orders-panel-body').innerHTML = '<div class="orders-empty">Could not load orders. Please try again.</div>';
    console.error('renderOrders error:', e);
  }
}

/* ─── POSTAGE ─────────────────────────────────────────────────────────────── */

/**
 * Returns the currently selected destination country's ISO2 code and
 * display name from the country dropdown. Defaults to AU if not found.
 */
function getSelectedCountry() {
  const select = el('country');
  if (!select) return { code: 'AU', name: 'Australia' };
  const opt = select.options[select.selectedIndex];
  return { code: select.value || 'AU', name: opt ? opt.text : 'Australia' };
}

/**
 * Shows/hides the postcode input in the postage section based on the
 * selected destination country. AusPost's international PAC API quotes
 * by country + weight only — no postcode is used or required for
 * international destinations.
 *
 * Called when the country dropdown changes, and once when checkout opens
 * so the section reflects whatever was already selected.
 */
function updatePostageSectionForCountry() {
  const { code, name } = getSelectedCountry();
  const isIntl = code !== 'AU';

  const postcodeGroup = el('postage-postcode-group');
  const intro         = el('postage-intro');
  if (postcodeGroup) postcodeGroup.style.display = isIntl ? 'none' : '';
  if (intro) {
    intro.textContent = isIntl
      ? 'Postage to ' + name + ' will be calculated based on Australia Post international rates. Click Calculate to see options.'
      : 'Enter your postcode to calculate shipping from Airlie Beach, then select a postage option to continue.';
  }

  // Clear any previous quotes — the destination has changed
  selectedPostage = null;
  selectedGelatoPostage = null;
  const resultEl = el('postage-result');
  if (resultEl) resultEl.innerHTML = '';
  const gelatoResultEl = el('gelato-postage-result');
  if (gelatoResultEl) gelatoResultEl.innerHTML = '';
  updateGelatoPostageVisibility();
  updateOrderSummary();
}

/**
 * Renders the AusPost service list into #postage-result — extracted
 * unchanged from the original single-quote implementation so
 * calculatePostage() can call it alongside the Gelato render below.
 */
function renderAusPostServices(data, resultEl, isIntl, countryName, postcode, itemCount) {
  if (data.services && data.services.length > 0) {
    selectedPostage = null;
    const servicesWrap = document.createElement('div'); servicesWrap.className = 'postage-services';
    const note = document.createElement('p'); note.className = 'postage-note';
    note.textContent = isIntl
      ? 'International postage from Airlie Beach to ' + countryName + (itemCount > 1 ? ' — combined rate for ' + itemCount + ' parcels' : '') + '. Select a service:'
      : (itemCount === 1
          ? 'Postage from Airlie Beach (4802) to ' + postcode + '. Select a service:'
          : 'Postage from Airlie Beach (4802) to ' + postcode + ' — combined rate for ' + itemCount + ' parcels. Select a service:');
    servicesWrap.appendChild(note);

    data.services.forEach((s, i) => {
      const label = document.createElement('label');
      label.className = 'postage-service postage-service-selectable'; label.htmlFor = 'postage-option-' + i;
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'postage-option'; radio.id = 'postage-option-' + i;
      radio.value = i; radio.className = 'postage-radio';
      radio.addEventListener('change', () => {
        selectedPostage = { name: s.name, price: s.price, quoteId: s.quoteId };
        updateOrderSummary(); el('payment-error').style.display = 'none';
      });
      const nameSpan = document.createElement('span'); nameSpan.className = 'postage-service-name'; nameSpan.textContent = s.name;
      const detailsSpan = document.createElement('span'); detailsSpan.className = 'postage-service-details';
      if (s.deliveryTime) { const d = document.createElement('span'); d.className = 'postage-delivery'; d.textContent = s.deliveryTime; detailsSpan.appendChild(d); }
      const priceSpan = document.createElement('span'); priceSpan.className = 'postage-price'; priceSpan.textContent = 'AUD $' + s.price.toFixed(2);
      detailsSpan.appendChild(priceSpan);
      label.appendChild(radio); label.appendChild(nameSpan); label.appendChild(detailsSpan);
      servicesWrap.appendChild(label);
    });

    const disclaimer = document.createElement('p'); disclaimer.className = 'postage-disclaimer';
    disclaimer.textContent = isIntl
      ? 'International shipments may be subject to customs duties or import taxes charged by the destination country — these are the responsibility of the buyer and are not included in the price shown. Michael will confirm and dispatch once payment is received.'
      : (itemCount === 1
          ? 'Selected postage will be added to your total. Michael will confirm and dispatch once payment is received.'
          : 'Combined postage for all ' + itemCount + ' works. Each will be carefully packaged and dispatched separately once payment is received.');
    servicesWrap.appendChild(disclaimer);
    resultEl.innerHTML = ''; resultEl.appendChild(servicesWrap);
  } else {
    selectedPostage = null;
    resultEl.innerHTML = '<p class="postage-error">' + (data.message || 'No postage options found. Please <a href="#contact" class="postage-contact-link">contact Michael</a> for a quote.') + '</p>';
  }
}

/**
 * Renders the Gelato print-shipping service list into
 * #gelato-postage-result — same visual pattern and radio-button
 * behaviour as the AusPost list, but with its own radio group name
 * (gelato-postage-option) so a selection in one block never clears a
 * selection in the other, and it updates selectedGelatoPostage instead
 * of selectedPostage.
 */
function renderGelatoServices(data, resultEl) {
  if (data.gelatoServices && data.gelatoServices.length > 0) {
    selectedGelatoPostage = null;
    const servicesWrap = document.createElement('div'); servicesWrap.className = 'postage-services';
    const note = document.createElement('p'); note.className = 'postage-note';
    note.textContent = 'Print shipping via Gelato — select a service:';
    servicesWrap.appendChild(note);

    data.gelatoServices.forEach((s, i) => {
      const label = document.createElement('label');
      label.className = 'postage-service postage-service-selectable'; label.htmlFor = 'gelato-postage-option-' + i;
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'gelato-postage-option'; radio.id = 'gelato-postage-option-' + i;
      radio.value = i; radio.className = 'postage-radio';
      radio.addEventListener('change', () => {
        selectedGelatoPostage = { name: s.name, price: s.price, quoteId: s.quoteId };
        updateOrderSummary(); el('payment-error').style.display = 'none';
      });
      const nameSpan = document.createElement('span'); nameSpan.className = 'postage-service-name'; nameSpan.textContent = s.name;
      const detailsSpan = document.createElement('span'); detailsSpan.className = 'postage-service-details';
      if (s.deliveryTime) { const d = document.createElement('span'); d.className = 'postage-delivery'; d.textContent = s.deliveryTime; detailsSpan.appendChild(d); }
      const priceSpan = document.createElement('span'); priceSpan.className = 'postage-price'; priceSpan.textContent = 'AUD $' + s.price.toFixed(2);
      detailsSpan.appendChild(priceSpan);
      label.appendChild(radio); label.appendChild(nameSpan); label.appendChild(detailsSpan);
      servicesWrap.appendChild(label);
    });

    const disclaimer = document.createElement('p'); disclaimer.className = 'postage-disclaimer';
    disclaimer.textContent = 'Produced and shipped directly by Gelato from whichever facility is closest to you — a separate parcel from any original paintings in your order.';
    servicesWrap.appendChild(disclaimer);
    resultEl.innerHTML = ''; resultEl.appendChild(servicesWrap);
  } else {
    selectedGelatoPostage = null;
    resultEl.innerHTML = '<p class="postage-error">' + (data.gelatoMessage || 'No print shipping options found. Please <a href="#contact" class="postage-contact-link">contact Michael</a> for a quote.') + '</p>';
  }
}

async function calculatePostage() {
  const { code: countryCode, name: countryName } = getSelectedCountry();
  const isIntl        = countryCode !== 'AU';
  const resultEl       = el('postage-result');
  const gelatoResultEl = el('gelato-postage-result');
  const btn            = el('postage-calc-btn');

  const auspostItems    = cart.filter(a => a.source !== 'gelato');
  const gelatoCartItems = cart.filter(a => a.source === 'gelato');

  // ── Domestic: postcode required (only when the cart has non-Gelato items) ─
  let postcode = '';
  if (auspostItems.length > 0 && !isIntl) {
    postcode = el('buyer-postcode').value.trim();
    if (!postcode || !/^[0-9]{4}$/.test(postcode)) {
      resultEl.innerHTML = '<p class="postage-error">Please enter a valid 4-digit postcode.</p>'; return;
    }
  }

  if (auspostItems.length > 0) {
    const itemsMissingDimensions = auspostItems.filter(a => !a.shipping || !a.shipping.weight || a.shipping.weight <= 0);
    if (itemsMissingDimensions.length > 0) {
      const names = itemsMissingDimensions.map(a => '"' + a.title + '"').join(', ');
      resultEl.innerHTML =
        '<p class="postage-error">Shipping dimensions are not set for ' + names + '. ' +
        'Please <a href="#contact" class="postage-contact-link">contact Michael</a> for a postage quote.</p>';
      return;
    }
  }

  const items = auspostItems.map(a => ({
    weight: a.shipping.weight, length: a.shipping.length,
    width:  a.shipping.width,  height: a.shipping.height,
  }));

  // ── Gelato: build gelatoItems + a recipient from the already-filled
  // checkout form fields (Part 6.2) — no new address fields needed.
  let gelatoItems = [];
  let recipient   = null;
  if (gelatoCartItems.length > 0) {
    gelatoItems = gelatoCartItems.map(a => ({ productUid: a.gelatoProductUid, quantity: 1 }));
    recipient = {
      firstName:    fieldVal('first-name'),
      lastName:     fieldVal('last-name'),
      addressLine1: fieldVal('address'),
      city:         fieldVal('city'),
      postCode:     fieldVal('postcode'),
      state:        fieldVal('state'),
      countryCode,
      email:        fieldVal('email'),
      phone:        fieldVal('phone'),
    };
  }

  btn.disabled = true; btn.textContent = 'Calculating…';
  if (auspostItems.length > 0) {
    const parcelWord = items.length === 1 ? 'parcel' : (items.length + ' parcels');
    resultEl.innerHTML = '<p class="postage-loading">Fetching ' + (isIntl ? 'international ' : '') + 'rates from Australia Post for ' + parcelWord + '…</p>';
  } else {
    resultEl.innerHTML = '';
  }
  if (gelatoCartItems.length > 0) {
    gelatoResultEl.innerHTML = '<p class="postage-loading">Fetching print shipping rates from Gelato…</p>';
  }

  try {
    const requestBody = {};
    if (auspostItems.length > 0) {
      Object.assign(requestBody, isIntl ? { toCountry: countryCode, items } : { toPostcode: postcode, items });
    }
    if (gelatoItems.length > 0) {
      requestBody.gelatoItems = gelatoItems;
      requestBody.recipient   = recipient;
    }

    const data = await apiFetch('/api/postage', {
      method: 'POST',
      body:   JSON.stringify(requestBody),
    });

    if (auspostItems.length > 0) {
      renderAusPostServices(data, resultEl, isIntl, countryName, postcode, items.length);
    }
    if (gelatoCartItems.length > 0) {
      renderGelatoServices(data, gelatoResultEl);
    }
  } catch (e) {
    if (auspostItems.length > 0) {
      resultEl.innerHTML = '<p class="postage-error">Could not calculate postage. Please <a href="#contact" class="postage-contact-link">contact Michael</a> for a shipping quote.</p>';
    }
    if (gelatoCartItems.length > 0) {
      gelatoResultEl.innerHTML = '<p class="postage-error">Could not calculate print shipping. Please <a href="#contact" class="postage-contact-link">contact Michael</a> for a shipping quote.</p>';
    }
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
    if (data.fallback) { errEl.innerHTML = data.error + ' — <a href="mailto:michael.p.vanblerk@gmail.com" style="color:#f5a0a0;">michael.p.vanblerk@gmail.com</a>'; return; }
    succEl.textContent = 'Message sent — Michael will be in touch soon.';
    el('contact-name').value = ''; el('contact-email').value = ''; el('contact-message').value = '';
  } catch (e) {
    errEl.textContent = e.message || 'Message could not be sent. Please email Michael directly.';
  } finally { btn.disabled = false; btn.textContent = 'Send message'; }
}

/* ─── NEWSLETTER SIGNUP POPUP ─────────────────────────────────────────────── */

// localStorage key — once a visitor sees the popup (submits OR dismisses it),
// it never shows again on that device. Using localStorage rather than
// sessionStorage so the dismissal persists across future visits, not just
// the current tab session.
const NEWSLETTER_SEEN_KEY = 'atelier_newsletter_seen';

// Delay before showing the popup to a new visitor, in milliseconds.
// Long enough that it doesn't feel like an ambush the instant the page loads.
const NEWSLETTER_POPUP_DELAY_MS = 4000;

function hasSeenNewsletterPopup() {
  try { return localStorage.getItem(NEWSLETTER_SEEN_KEY) === '1'; }
  catch { return true; } // if localStorage is blocked, err on the side of not nagging
}

function markNewsletterPopupSeen() {
  try { localStorage.setItem(NEWSLETTER_SEEN_KEY, '1'); } catch {}
}

function openNewsletterPopup() {
  const overlay = el('newsletter-overlay');
  if (!overlay) return;
  overlay.classList.add('open');
}

function closeNewsletterPopup() {
  const overlay = el('newsletter-overlay');
  if (overlay) overlay.classList.remove('open');
  markNewsletterPopupSeen();
}

/**
 * Schedules the newsletter popup to appear after a delay, but only for
 * visitors who haven't seen it before (tracked in localStorage) and only
 * once the admin login modal, checkout, or add-painting panel aren't
 * already open (avoids an awkward double-modal situation).
 */
function scheduleNewsletterPopup() {
  if (hasSeenNewsletterPopup()) return;
  if (isAdmin) return; // never show the marketing popup to the site owner

  setTimeout(() => {
    // Don't interrupt if the visitor already has another modal open
    const anyModalOpen = [
      'checkout-modal', 'login-overlay', 'add-panel',
      'orders-panel', 'confirm-overlay', 'lightbox-overlay',
    ].some(id => {
      const elToCheck = el(id);
      return elToCheck && (elToCheck.classList.contains('open') || elToCheck.classList.contains('visible'));
    });
    if (anyModalOpen || hasSeenNewsletterPopup()) return;

    openNewsletterPopup();
  }, NEWSLETTER_POPUP_DELAY_MS);
}

async function submitNewsletterSignup() {
  const errEl  = el('newsletter-error');
  const succEl = el('newsletter-success');
  const btn    = el('newsletter-submit-btn');

  const name  = el('newsletter-name').value.trim();
  const email = el('newsletter-email').value.trim();

  errEl.textContent = ''; succEl.textContent = '';

  if (!name)  { errEl.textContent = 'Please enter your name.'; return; }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errEl.textContent = 'Please enter a valid email address.'; return;
  }

  btn.disabled = true; btn.textContent = 'Joining…';

  try {
    const data = await apiFetch('/api/contact', {
      method: 'POST',
      body:   JSON.stringify({ type: 'newsletter', name, email }),
    });

    if (data.fallback) {
      errEl.textContent = data.error || 'Sign-up could not be completed right now.';
      return;
    }

    succEl.textContent = "You're on the list — thank you!";
    el('newsletter-name').value  = '';
    el('newsletter-email').value = '';
    markNewsletterPopupSeen();

    // Close the popup shortly after showing the success message
    setTimeout(closeNewsletterPopup, 1500);

  } catch (e) {
    errEl.textContent = e.message || 'Sign-up could not be completed. Please try again.';
  } finally {
    btn.disabled = false; btn.textContent = 'Join the mailing list';
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
  const errEl = el('payment-error'); errEl.textContent = msg; errEl.style.display = 'block';
}

/* ─── FORM HELPERS ────────────────────────────────────────────────────────── */
function fieldVal(id)       { return el(id).value.trim(); }
function hasHtml(str)       { return /[<>]/.test(str); }
function validPhone(str)    { return /^[0-9+\s\-]{6,20}$/.test(str); }

/**
 * Validates a postcode/postal code. Domestic (AU) postcodes must be
 * exactly 4 digits. International postal codes vary hugely in format
 * (alphanumeric, with spaces or hyphens, or absent entirely in a small
 * number of countries) — so for non-AU destinations we accept a lenient
 * format: 2–12 characters, letters/digits/spaces/hyphens only.
 */
function validPostcode(str, countryCode) {
  if (!countryCode || countryCode === 'AU') {
    return /^[0-9]{4,10}$/.test(str);
  }
  return /^[A-Za-z0-9\s\-]{2,12}$/.test(str);
}
function validEmail(str)    { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str); }

function validateForm() {
  const { code: countryCode } = getSelectedCountry();

  const textFields = [
    ['first-name', 'First name'], ['last-name', 'Last name'],
    ['address', 'Street address'], ['city', 'City'],
  ];
  for (var i = 0; i < textFields.length; i++) {
    var id = textFields[i][0]; var label = textFields[i][1];
    const val = fieldVal(id);
    if (!val) { showPaymentError('Please enter your ' + label + '.'); return null; }
    if (hasHtml(val)) { showPaymentError(label + ' must not contain HTML characters.'); return null; }
  }

  // State is optional for international addresses (many countries don't use
  // the concept the same way Australia does) but still checked for HTML if filled.
  const stateVal = fieldVal('state');
  if (countryCode === 'AU' && !stateVal) { showPaymentError('Please enter your state.'); return null; }
  if (stateVal && hasHtml(stateVal)) { showPaymentError('State must not contain HTML characters.'); return null; }

  const email = fieldVal('email');
  if (!email) { showPaymentError('Please enter your email address.'); return null; }
  if (hasHtml(email) || !validEmail(email)) { showPaymentError('Please enter a valid email address.'); return null; }
  const phone = fieldVal('phone');
  if (phone && !validPhone(phone)) { showPaymentError('Please enter a valid phone number (digits, spaces, + and - only).'); return null; }

  const postcode = fieldVal('postcode');
  if (!postcode) { showPaymentError('Please enter your postcode.'); return null; }
  if (hasHtml(postcode)) { showPaymentError('Postcode must not contain HTML characters.'); return null; }
  if (!validPostcode(postcode, countryCode)) { showPaymentError('Please enter a valid postcode for the selected country.'); return null; }

  const countrySelect = el('country');
  const countryName   = countrySelect ? countrySelect.options[countrySelect.selectedIndex].text : 'Australia';

  return {
    firstName: fieldVal('first-name'), lastName: fieldVal('last-name'),
    email, phone, address: fieldVal('address'), city: fieldVal('city'),
    state: stateVal, postcode, country: countryName,
  };
}

async function handlePayment() {
  el('payment-error').style.display = 'none';
  const fields = validateForm(); if (!fields) return;

  // Mirrors the server-side check in create-payment.js: block submission
  // if the cart needs a postage selection for a domain (AusPost and/or
  // Gelato) that hasn't been quoted/selected yet, so the buyer finds out
  // immediately rather than only after Square tokenizes their card.
  const sources = getCartSources();
  if (sources.has('auspost') && !selectedPostage) {
    showPaymentError('Please calculate postage and select a shipping option before completing your purchase.'); return;
  }
  if (sources.has('gelato') && !selectedGelatoPostage) {
    showPaymentError('Please calculate print shipping and select a shipping option before completing your purchase.'); return;
  }
  if (!squareCard) { showPaymentError('Payment form is not ready. Please try again.'); return; }
  const btn = el('pay-btn'); btn.disabled = true; btn.textContent = 'Processing…';
  try {
    const result = await squareCard.tokenize();
    if (result.status === 'OK') {
      await processPayment(result.token, fields);
    } else {
      const code = result.errors && result.errors[0] ? result.errors[0].code : '';
      showPaymentError(safeCardError(code));
      if (squareCard.clear) await squareCard.clear();
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

  const sources = getCartSources();
  if (sources.has('auspost') && !selectedPostage) {
    showPaymentError('Please select a postage option before completing your purchase.');
    const btn = el('pay-btn'); btn.disabled = false; btn.textContent = 'Complete Purchase'; return;
  }
  if (sources.has('gelato') && !selectedGelatoPostage) {
    showPaymentError('Please select a print shipping option before completing your purchase.');
    const btn = el('pay-btn'); btn.disabled = false; btn.textContent = 'Complete Purchase'; return;
  }

  // One or two quote IDs — create-payment.js (Part 5.4) accepts this
  // array shape, with the old singular postageQuoteId kept server-side
  // only as a backwards-compatible fallback.
  const postageQuoteIds = [];
  if (selectedPostage)       postageQuoteIds.push(selectedPostage.quoteId);
  if (selectedGelatoPostage) postageQuoteIds.push(selectedGelatoPostage.quoteId);

  const { code: countryCode } = getSelectedCountry();

  try {
    const data = await apiFetch('/api/create-payment', {
      method: 'POST',
      body: JSON.stringify({
        sourceId, currency: 'AUD',
        email: recheck.email, firstName: recheck.firstName, lastName: recheck.lastName,
        address: recheck.address, city: recheck.city, state: recheck.state,
        postcode: recheck.postcode, phone: recheck.phone, country: recheck.country,
        countryCode, // ISO2 — required whenever the cart contains a Gelato item
        items: cart.map(a => ({ id: a.id })),
        postageQuoteIds,
      }),
    });
    if (squareCard.clear) await squareCard.clear();
    await loadArtworks();
    cart = []; selectedPostage = null; selectedGelatoPostage = null;
    updateCartUI(); showSuccess(data.orderId);
  } catch (e) {
    const msg = isSafeServerMessage(e.message)
      ? e.message
      : 'Payment could not be processed. Please check your card details and try again.';
    showPaymentError(msg);
    if (squareCard.clear) await squareCard.clear();
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
    .some(function(s) { return msg.indexOf(s) !== -1; });
}

function showSuccess(orderId) {
  el('checkout-body').style.display = 'none';
  el('success-state').style.display = 'block';
  el('success-order-id').textContent = 'Order ' + orderId;
}

function resetShop() {
  squareCard = null; squarePayments = null;
  el('card-container').innerHTML = '';
  renderGallery(); closeCheckout();
}

/* ─── BOOT ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {

  const wire = function(id, event, fn) {
    try {
      const element = el(id);
      if (element) element.addEventListener(event, fn);
      else console.warn('Could not wire event — element not found:', id);
    } catch (e) { console.error('Failed to wire event on', id, e); }
  };

  wire('cart-toggle-btn',        'click', toggleCart);
  wire('admin-nav-link',         'click', function(e) { e.preventDefault(); openLogin(); });
  wire('cart-overlay',           'click', closeCart);
  wire('cart-close-btn',         'click', closeCart);
  wire('checkout-btn',           'click', openCheckout);
  wire('checkout-close-btn',     'click', closeCheckout);
  wire('pay-btn',                'click', handlePayment);
  wire('postage-calc-btn',       'click', calculatePostage);
  wire('buyer-postcode',         'keydown', function(e) { if (e.key === 'Enter') calculatePostage(); });
  wire('success-continue-btn',   'click', resetShop);
  wire('login-btn',              'click', attemptLogin);
  wire('login-cancel-btn',       'click', closeLogin);
  wire('admin-pw',               'keydown', function(e) { if (e.key === 'Enter') attemptLogin(); });
  wire('pw-toggle-btn',          'click', function() {
    const input = el('admin-pw'); const btn = el('pw-toggle-btn');
    const show  = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  wire('admin-orders-btn',       'click', openOrders);
  wire('admin-add-btn',          'click', openAddPanel);
  wire('admin-logout-btn',       'click', adminLogout);
  wire('orders-close-btn',       'click', closeOrders);
  wire('artist-photo-upload-btn','click', function() { el('artist-photo-file').click(); });
  wire('artist-photo-file',      'change', handleArtistPhotoUpload);
  wire('artist-photo-remove-btn','click', removeArtistPhoto);
  wire('add-panel-close-btn',    'click', closeAddPanel);
  wire('img-strip-add-btn',      'click', function() { el('img-file').click(); });
  wire('img-file',               'change', handleImgUpload);
  wire('save-painting-btn',      'click', saveNewPainting);
  wire('contact-form-btn',       'click', submitContactForm);

  // Newsletter signup popup
  wire('newsletter-close-btn',   'click', closeNewsletterPopup);
  wire('newsletter-dismiss-btn', 'click', closeNewsletterPopup);
  wire('newsletter-submit-btn',  'click', submitNewsletterSignup);
  wire('newsletter-overlay',     'click', function(e) { if (e.target === el('newsletter-overlay')) closeNewsletterPopup(); });
  wire('newsletter-name',        'keydown', function(e) { if (e.key === 'Enter') submitNewsletterSignup(); });
  wire('newsletter-email',       'keydown', function(e) { if (e.key === 'Enter') submitNewsletterSignup(); });
  wire('confirm-cancel-btn',     'click', closeConfirm);
  wire('confirm-delete-btn',     'click', executeDeletion);
  wire('lightbox-close',         'click', closeLightbox);
  wire('lightbox-prev',          'click', lightboxPrev);
  wire('lightbox-next',          'click', lightboxNext);
  wire('lightbox-overlay',       'click', function(e) { if (e.target === el('lightbox-overlay')) closeLightbox(); });

  // Listing type — toggles shipping-dimensions / Gelato-fields visibility (admin panel)
  wire('listing-type-original', 'change', updateListingTypeToggle);
  wire('listing-type-oversized', 'change', updateListingTypeToggle);
  wire('listing-type-gelato',   'change', updateListingTypeToggle);
  wire('gelato-import-btn',     'click',  importFromGelato);

  // Collections tag input (add/edit panel)
  wire('collections-add-btn', 'click', addCollectionFromInput);
  wire('new-collection-input', 'keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); addCollectionFromInput(); } });

  // Drag-and-drop reordering — dragover is wired once on each grid
  // container here; dragstart/dragend are wired per-card in buildCard().
  wire('gallery-seascapes',  'dragover', function(e) { handleGalleryDragOver(e, el('gallery-seascapes')); });
  wire('gallery-figurative', 'dragover', function(e) { handleGalleryDragOver(e, el('gallery-figurative')); });

  // Country dropdown — toggles postcode field and resets postage quote
  wire('country', 'change', updatePostageSectionForCountry);

  document.addEventListener('keydown', function(e) {
    try {
      if (!el('lightbox-overlay').classList.contains('open')) return;
      if (e.key === 'Escape')     closeLightbox();
      if (e.key === 'ArrowRight') lightboxNext();
      if (e.key === 'ArrowLeft')  lightboxPrev();
    } catch (err) { console.error('keydown handler failed:', err); }
  });

  (function() {
    function run() {
      loadArtworks().then(function() {
        try { renderGallery(); } catch(e) {
          console.error('renderGallery failed:', e);
          ['gallery-seascapes', 'gallery-figurative'].forEach(function(id) {
            const grid = el(id);
            if (grid) grid.innerHTML = '<p class="gallery-empty">Gallery could not be loaded. Please refresh the page.</p>';
          });
        }
        try { updateCartUI(); } catch(e) { console.error('updateCartUI failed:', e); }
        try { if (isLoggedIn()) activateAdminMode(); } catch(e) { console.error('activateAdminMode failed:', e); }
        try { scheduleNewsletterPopup(); } catch(e) { console.error('scheduleNewsletterPopup failed:', e); }
      }).catch(function(e) {
        console.error('loadArtworks failed:', e);
      });
    }
    try { run(); } catch(e) { console.error('Boot failed:', e); }
  })();
});
