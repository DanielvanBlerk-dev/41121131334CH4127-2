/* Shared by every page: the mobile menu, plus sending old links to the
   front page's former Commissions section on to its own page. */
(function () {
  if (location.hash === '#commissions') {
    location.replace('/commissions');
    return;
  }

  var toggle = document.getElementById('nav-toggle');
  var links = document.getElementById('nav-links');
  if (!toggle || !links) return;

  function setOpen(open) {
    links.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.textContent = open ? 'Close' : 'Menu';
  }

  toggle.addEventListener('click', function () {
    setOpen(!links.classList.contains('open'));
  });
  links.addEventListener('click', function (e) {
    if (e.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') setOpen(false);
  });
})();

/* Site banner — the announcement Michael edits from the admin bar (see
   api/_banner.js). Same look and place as the October Night Sea banner:
   between the featured painting and the gallery on the front page, under
   the page heading elsewhere. The front page gets the banner with the
   gallery data (script.js calls renderSiteBanner); other pages fetch it
   here. All text goes in with textContent, never as HTML. */
(function () {
  var PATH = location.pathname.replace(/\.html$/, '').replace(/\/+$/, '');
  var PAGE = (PATH === '' || PATH === '/index') ? 'home' : PATH.replace(/^\//, '');

  // Extra Google Fonts, loaded only when a banner uses them. The two site
  // fonts are already on every page.
  var EXTRA_FONTS = {
    'playfair':    'Playfair+Display:ital,wght@0,400;1,400',
    'lora':        'Lora:ital,wght@0,400;1,400',
    'montserrat':  'Montserrat:wght@300;400;500',
    'great-vibes': 'Great+Vibes'
  };
  var FONT_KEYS = ['cormorant', 'dm-mono', 'playfair', 'lora', 'montserrat', 'great-vibes'];

  function loadFonts(keys) {
    var families = [];
    keys.forEach(function (k) {
      if (EXTRA_FONTS[k] && families.indexOf(EXTRA_FONTS[k]) === -1) families.push(EXTRA_FONTS[k]);
    });
    if (!families.length) return;
    var href = 'https://fonts.googleapis.com/css2?family=' + families.join('&family=') + '&display=swap';
    if (document.querySelector('link[data-banner-fonts="' + href + '"]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = href; link.setAttribute('data-banner-fonts', href);
    document.head.appendChild(link);
  }

  function part(tag, className, text, font) {
    var node = document.createElement(tag);
    node.className = className + ' banner-font-' + (FONT_KEYS.indexOf(font) === -1 ? 'dm-mono' : font);
    node.textContent = text;
    return node;
  }

  window.renderSiteBanner = function (banner) {
    var old = document.getElementById('site-banner');
    if (old) old.parentNode.removeChild(old);
    if (!banner || !banner.enabled || !Array.isArray(banner.pages) || banner.pages.indexOf(PAGE) === -1) return;

    var fonts = banner.fonts || {};
    var section = document.createElement('section');
    section.className = 'announcement-banner';
    section.id = 'site-banner';
    section.setAttribute('aria-label', 'Announcement');
    var inner = document.createElement('div');
    inner.className = 'announcement-inner banner-align-' +
      (['left', 'center', 'right'].indexOf(banner.align) === -1 ? 'center' : banner.align);

    if (banner.headline) inner.appendChild(part('p', 'announcement-headline', banner.headline, fonts.headline));
    if (banner.body)     inner.appendChild(part('p', 'announcement-body', banner.body, fonts.body));
    if (banner.note)     inner.appendChild(part('p', 'announcement-note', banner.note, fonts.note));
    // No backslashes: browsers read "/\x.com" as "//x.com", another site.
    if (banner.buttonLabel && /^(\/(?!\/)|#|https:\/\/)[^\\\s]*$/.test(banner.buttonLink || '')) {
      var a = part('a', 'announcement-cta', banner.buttonLabel, fonts.button);
      a.href = banner.buttonLink;
      if (/^https:\/\//.test(banner.buttonLink)) { a.target = '_blank'; a.rel = 'noopener'; }
      inner.appendChild(a);
    }
    if (!inner.childNodes.length) return;
    section.appendChild(inner);

    loadFonts([fonts.headline, fonts.body, fonts.note, fonts.button]);

    var anchor = PAGE === 'home'
      ? document.getElementById('gallery')
      : document.querySelector('.policy-hero');
    if (!anchor) return;
    if (PAGE === 'home') anchor.parentNode.insertBefore(section, anchor);
    else anchor.parentNode.insertBefore(section, anchor.nextSibling);
  };

  // The front page renders it from the gallery data instead (script.js).
  if (PAGE === 'home') return;
  fetch('/api/get-artworks?only=banner', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) { if (data) window.renderSiteBanner(data.banner); })
    .catch(function () { /* no banner is fine */ });
})();
