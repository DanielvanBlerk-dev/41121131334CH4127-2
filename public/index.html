<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Atelier — Original Fine Art</title>

  <!--
    Content-Security-Policy is set via HTTP headers in vercel.json.
    The meta tag below is a fallback only (headers take precedence).
  -->

  <!-- Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Mono:wght@300;400&display=swap" rel="stylesheet">

  <!-- Styles -->
  <link rel="stylesheet" href="style.css">

  <!-- Square Web Payments SDK (sandbox — swap URL for production) -->
  <script src="https://sandbox.web.squarecdn.com/v1/square.js" defer></script>

  <!-- App config then app logic -->
  <script src="square-config.js" defer></script>
  <script src="script.js" defer></script>
</head>
<body>

  <!-- ── ADMIN BAR ──────────────────────────────────────────────────────── -->
  <div class="admin-bar" id="admin-bar" role="banner" aria-label="Admin toolbar">
    <div class="admin-bar-left">
      <span class="admin-badge">Admin</span>
      <span style="color:rgba(255,255,255,0.5);">Viewing as owner</span>
    </div>
    <div style="display:flex;gap:10px;">
      <button class="admin-btn" id="admin-add-btn">+ Add painting</button>
      <button class="admin-btn danger" id="admin-logout-btn">Log out</button>
    </div>
  </div>

  <!-- ── NAV ───────────────────────────────────────────────────────────── -->
  <nav role="navigation" aria-label="Main">
    <a href="#" class="nav-logo">Ate<span>lier</span></a>
    <div class="nav-right">
      <a href="#gallery" class="nav-link">Works</a>
      <a href="#about"   class="nav-link">About</a>
      <a href="#" class="nav-link" id="admin-nav-link" title="Owner login" aria-label="Owner login">&#9679;</a>
      <button class="cart-btn" id="cart-toggle-btn" aria-label="Open cart">
        Cart <span class="cart-count" id="cart-count">0</span>
      </button>
    </div>
  </nav>

  <!-- ── HERO ──────────────────────────────────────────────────────────── -->
  <section class="hero" aria-label="Introduction">
    <div>
      <p class="hero-eyebrow">Original Fine Art — Unique Works</p>
      <h1 class="hero-title">
        Paintings made<br>to be<br><em>lived with.</em>
      </h1>
      <p class="hero-sub">Each work is a singular original — oil and acrylic on linen or board. Signed, certificated, and shipped directly from the studio.</p>
    </div>
    <div class="hero-right" aria-hidden="true">
      <div class="hero-stat">VI</div>
      <div class="hero-stat-label">Works Available</div>
    </div>
  </section>

  <!-- ── GALLERY ────────────────────────────────────────────────────────── -->
  <section class="section" id="gallery" aria-label="Current collection">
    <div class="section-header">
      <h2 class="section-title">Current Collection</h2>
      <span class="section-meta">All works — oil on linen unless noted</span>
    </div>
    <div class="gallery" id="gallery-grid"></div>
  </section>

  <!-- ── ABOUT ─────────────────────────────────────────────────────────── -->
  <section class="section about-section" id="about" aria-label="About the artist">
    <div class="about-inner">
      <p class="hero-eyebrow" style="text-align:center;">The Artist</p>
      <h2 class="about-title">A studio practice<br><em>rooted in observation.</em></h2>
      <p class="about-body">Each painting begins with weeks of looking — at light, at form, at the particular quality of stillness in a moment. Works are produced in small series and sold as unique originals. Certificates of authenticity are included with every purchase.</p>
      <p class="about-location">Studio — Townsville, QLD, Australia</p>
    </div>
  </section>

  <!-- ── FOOTER ────────────────────────────────────────────────────────── -->
  <footer role="contentinfo">
    <span class="footer-logo">Atelier</span>
    <span>&#169; 2026 &middot; All works original &middot; Secure payment via Square</span>
    <span class="footer-ssl">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <rect x="3" y="11" width="18" height="11" rx="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
      SSL Secured
    </span>
  </footer>

  <!-- ── CART OVERLAY + PANEL ──────────────────────────────────────────── -->
  <div class="cart-overlay" id="cart-overlay" aria-hidden="true"></div>
  <aside class="cart-panel" id="cart-panel" aria-label="Shopping cart" role="complementary">
    <div class="cart-head">
      <h2 class="cart-head-title">Your Selection</h2>
      <button class="close-btn" id="cart-close-btn" aria-label="Close cart">&#x2715;</button>
    </div>
    <div class="cart-items" id="cart-items">
      <div class="cart-empty" id="cart-empty">No works selected yet.</div>
    </div>
    <div class="cart-footer">
      <div class="cart-total">
        <span class="cart-total-label">Total</span>
        <span class="cart-total-amount" id="cart-total">$0</span>
      </div>
      <button class="checkout-btn" id="checkout-btn" disabled>Proceed to Checkout</button>
    </div>
  </aside>

  <!-- ── CHECKOUT MODAL ────────────────────────────────────────────────── -->
  <div class="modal-overlay" id="checkout-modal" role="dialog" aria-modal="true" aria-label="Checkout">
    <div class="modal">
      <div class="modal-head">
        <h2 class="modal-title">Checkout</h2>
        <button class="close-btn" id="checkout-close-btn" aria-label="Close checkout">&#x2715;</button>
      </div>
      <div class="modal-body" id="checkout-body">

        <div class="sandbox-notice" role="note">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <strong>Sandbox mode</strong>&nbsp;&middot; Test card: 4111 1111 1111 1111, any future date, CVV 111
        </div>

        <div class="order-summary" id="order-summary"></div>

        <div class="form-section">
          <div class="form-section-title">Contact</div>
          <div class="form-row">
            <div class="form-group">
              <label for="first-name">First name</label>
              <input type="text" id="first-name" autocomplete="given-name" placeholder="Jane">
            </div>
            <div class="form-group">
              <label for="last-name">Last name</label>
              <input type="text" id="last-name" autocomplete="family-name" placeholder="Smith">
            </div>
          </div>
          <div class="form-group">
            <label for="email">Email</label>
            <input type="email" id="email" autocomplete="email" placeholder="jane@example.com">
          </div>
          <div class="form-group">
            <label for="phone">Phone</label>
            <input type="tel" id="phone" autocomplete="tel" placeholder="+61 400 000 000">
          </div>
        </div>

        <div class="form-section">
          <div class="form-section-title">Shipping address</div>
          <div class="form-group">
            <label for="address">Street address</label>
            <input type="text" id="address" autocomplete="street-address" placeholder="123 Main Street">
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="city">City</label>
              <input type="text" id="city" autocomplete="address-level2" placeholder="Townsville">
            </div>
            <div class="form-group">
              <label for="state">State</label>
              <input type="text" id="state" autocomplete="address-level1" placeholder="QLD">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label for="postcode">Postcode</label>
              <input type="text" id="postcode" autocomplete="postal-code" placeholder="4810">
            </div>
            <div class="form-group">
              <label for="country">Country</label>
              <input type="text" id="country" autocomplete="country-name" value="Australia">
            </div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-section-title">Payment</div>
          <div id="card-container"></div>
          <p class="sq-card-message">Payments processed securely by Square. We never store your card details.</p>
          <p class="payment-error" id="payment-error" role="alert"></p>
          <button class="pay-btn" id="pay-btn">Complete Purchase</button>
        </div>

      </div><!-- /#checkout-body -->

      <!-- Success state -->
      <div class="success-state" id="success-state" role="status">
        <div class="success-icon" aria-hidden="true">&#10022;</div>
        <h2 class="success-title">Thank you.</h2>
        <p class="success-sub">
          Your order has been confirmed and payment received.<br>
          A confirmation has been sent to your email.<br>
          Your artwork will be carefully packaged and shipped within 5&#8209;7 business days.
        </p>
        <p class="success-order" id="success-order-id"></p>
        <button class="success-continue" id="success-continue-btn">Continue Browsing</button>
      </div>

    </div><!-- /.modal -->
  </div><!-- /#checkout-modal -->

  <!-- ── LOGIN MODAL ────────────────────────────────────────────────────── -->
  <div class="login-overlay" id="login-overlay" role="dialog" aria-modal="true" aria-label="Owner login">
    <div class="login-box">
      <h2 class="login-title">Owner login</h2>
      <p class="login-sub">Enter your admin password to manage the gallery.</p>
      <div class="form-group">
        <label for="admin-pw">Password</label>
        <input type="password" id="admin-pw" placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;">
      </div>
      <p class="login-error" id="login-error" role="alert"></p>
      <button class="login-btn" id="login-btn">Sign in</button>
      <button class="login-cancel" id="login-cancel-btn">Cancel</button>
    </div>
  </div>

  <!-- ── ADD PAINTING PANEL ─────────────────────────────────────────────── -->
  <aside class="add-panel" id="add-panel" role="dialog" aria-modal="true" aria-label="Add a painting">
    <div class="add-panel-head">
      <h2 class="add-panel-title">Add a painting</h2>
      <button class="close-btn" id="add-panel-close-btn" aria-label="Close panel">&#x2715;</button>
    </div>
    <div class="add-panel-body">
      <div class="img-upload-area" id="img-upload-area" role="button" tabindex="0" aria-label="Upload painting image">
        <input type="file" id="img-file" accept="image/*" style="display:none;">
        <div id="img-placeholder">
          <div style="font-size:24px;margin-bottom:8px;color:var(--gold);">+</div>
          <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);">Click to upload image</div>
          <div style="font-size:10px;color:var(--muted);margin-top:4px;">JPG, PNG, WEBP</div>
        </div>
        <img id="img-preview-el" class="img-preview" alt="Preview of uploaded painting">
      </div>
      <div class="form-group">
        <label for="new-title">Title</label>
        <input type="text" id="new-title" placeholder="e.g. Still Life with Roses">
      </div>
      <div class="form-group">
        <label for="new-medium">Medium &amp; dimensions</label>
        <input type="text" id="new-medium" placeholder="e.g. Oil on linen · 40 × 50 cm">
      </div>
      <div class="form-group">
        <label for="new-price">Price (AUD)</label>
        <input type="number" id="new-price" placeholder="1200" min="0">
      </div>
      <div class="form-group" style="display:flex;align-items:center;gap:10px;margin-top:4px;">
        <input type="checkbox" id="new-sold">
        <label for="new-sold" style="margin:0;text-transform:none;letter-spacing:0;font-size:12px;">Mark as sold</label>
      </div>
      <p id="add-error" style="color:#c0392b;font-size:11px;margin-top:8px;min-height:16px;" role="alert"></p>
    </div>
    <div class="add-panel-footer">
      <button class="save-btn" id="save-painting-btn">Save painting to gallery</button>
    </div>
  </aside>

  <!-- ── DELETE CONFIRM ─────────────────────────────────────────────────── -->
  <div class="confirm-overlay" id="confirm-overlay" role="dialog" aria-modal="true" aria-label="Confirm deletion">
    <div class="confirm-box">
      <h2 class="confirm-title">Remove painting?</h2>
      <p class="confirm-sub" id="confirm-sub">This will remove the work from your gallery permanently.</p>
      <div class="confirm-btns">
        <button class="confirm-cancel" id="confirm-cancel-btn">Cancel</button>
        <button class="confirm-delete" id="confirm-delete-btn">Remove</button>
      </div>
    </div>
  </div>

</body>
</html>
