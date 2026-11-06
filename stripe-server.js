/**
 * NaturalJuices — shop backend (v5)
 * ---------------------------------
 * 1. Card payments   — creates Stripe Checkout Sessions (prices looked up here, never trusted from the browser).
 * 2. Order book      — every order (card + PayPal) is saved in a PostgreSQL database.
 * 3. Admin dashboard — https://<this-server>/admin  (password protected) to view, search, update and export orders.
 * 4. Order tracking  — customers can look up an order with their order number + email.
 * 5. Emails          — optional new-order / confirmation / dispatch emails (see mailer.js).
 *
 * ENVIRONMENT VARIABLES (Render → the "Naturaljuices" service → Environment):
 *   STRIPE_SECRET_KEY       Stripe secret/restricted key (sk_test_/rk_test_ = test, sk_live_/rk_live_ = live)
 *   DATABASE_URL            PostgreSQL connection string — REQUIRED for orders to be recorded
 *   ADMIN_PASSWORD          password for the /admin dashboard — REQUIRED to use the dashboard
 *   SESSION_SECRET          optional; random string used to sign the admin login cookie
 *   STRIPE_WEBHOOK_SECRET   optional but recommended — signing secret of the Stripe webhook (/webhook/stripe)
 *   PAYPAL_CLIENT_ID        PayPal REST app client id   } with these two set, every PayPal order is
 *   PAYPAL_SECRET           PayPal REST app secret      } verified with PayPal before it is recorded
 *   PAYPAL_WEBHOOK_ID       optional — id of the PayPal webhook (/webhook/paypal)
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM / ORDER_ALERT_EMAIL   optional emails (mailer.js)
 *   SHEET_WEBHOOK_URL / SHEET_TOKEN   optional legacy Google-Sheet relay
 */
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');
const mailer = require('./mailer');

// ---- Stripe (created lazily so a missing key can't crash the whole server) ----
let _stripe = null;
function stripe() {
  if (_stripe) return _stripe;
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Card payments are not configured');
  const opts = {};
  if (process.env.STRIPE_API_HOST) { // used only by the automated tests
    opts.host = process.env.STRIPE_API_HOST; opts.port = process.env.STRIPE_API_PORT; opts.protocol = 'http';
  }
  _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, opts);
  return _stripe;
}

const CATALOG = JSON.parse(fs.readFileSync(__dirname + '/catalog.json', 'utf8'));
const byId = Object.fromEntries(CATALOG.map(p => [p.id, p]));

const SHOP_URL = 'https://naturaljuices.co.uk';
const ALLOWED_ORIGINS = [
  'https://naturaljuices-site.onrender.com',
  'https://new.naturaljuices.co.uk',
  'https://naturaljuices.co.uk',
  'https://www.naturaljuices.co.uk',
].concat((process.env.EXTRA_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
function safeReturnUrl(url, fallback) {
  if (typeof url === 'string' && ALLOWED_ORIGINS.some(p => url.startsWith(p + '/') || url === p)) return url;
  return fallback;
}

// ---- Pricing (server-side source of truth) -----------------------------------
/** Price of one basket line unit. strict=false is used when recording an order that has ALREADY been paid. */
function unitPrice(item, strict = true) {
  const p = byId[item.id];
  if (!p) throw new Error('Unknown product id ' + item.id);
  if (strict && p.out) throw new Error(p.name + ' is out of stock');
  if (item.pack) {
    const pk = (p.packs || []).find(x => x[0] === item.pack);
    if (!pk) throw new Error('Unknown pack "' + item.pack + '" for ' + p.name);
    const m = String(pk[0]).match(/\d+/);
    const bottles = m ? parseInt(m[0], 10) : 1;
    return { price: pk[1] * bottles, label: p.name + ' — ' + pk[0], name: p.name, pack: pk[0] };
  }
  return { price: p.price, label: p.name, name: p.name, pack: null };
}
const clampQty = q => Math.max(1, Math.min(99, parseInt(q, 10) || 1));
const PROMOS = {}; // e.g. { WELCOME10: 0.10 } — none active

/** Turns the browser's basket into priced order lines + totals (all in pence). */
function priceBasket(items, promo, strict = true) {
  if (!Array.isArray(items) || !items.length) throw new Error('Empty basket');
  if (items.length > 100) throw new Error('Too many items');
  const code = promo && promo.toUpperCase ? promo.toUpperCase() : null;
  const rate = code && PROMOS[code] ? PROMOS[code] : 0;
  const lines = items.map(i => {
    const u = unitPrice(i, strict);
    const qty = clampQty(i.qty);
    const unit_pence = Math.round(u.price * 100);
    return { id: i.id, name: u.name, pack: u.pack, label: u.label, qty, unit_pence, line_pence: unit_pence * qty };
  });
  const subtotal = lines.reduce((s, l) => s + l.line_pence, 0);
  const discount = Math.round(subtotal * rate);
  return { lines, subtotal, discount, total: subtotal - discount, code: rate ? code : '', rate };
}
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
function cleanCustomer(c) {
  c = c || {};
  return {
    customer_name: str(c.name), customer_email: str(c.email).toLowerCase(), customer_phone: str(c.phone, 40),
    address: str(c.address, 300), city: str(c.city, 100), postcode: str(c.postcode, 20).toUpperCase(),
    country: str(c.country, 80), customer_notes: str(c.notes, 500),
  };
}
const itemsForDb = lines => lines.map(l => ({ id: l.id, name: l.name, pack: l.pack, qty: l.qty, unit_pence: l.unit_pence, line_pence: l.line_pence }));

// ---- Legacy Google-Sheet relay (only if SHEET_WEBHOOK_URL is set) -------------
async function postToSheet(o) {
  if (!process.env.SHEET_WEBHOOK_URL) return;
  try {
    await fetch(process.env.SHEET_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: process.env.SHEET_TOKEN || '', source: o.payment_method === 'paypal' ? 'PayPal' : 'Stripe',
        ref: o.order_no + ' / ' + (o.payment_ref || ''), name: o.customer_name, email: o.customer_email, phone: o.customer_phone,
        amount: (o.total_pence / 100).toFixed(2),
        items: (o.items || []).map(i => i.qty + '× ' + i.name + (i.pack ? ' — ' + i.pack : '')).join(', '),
        address: [o.address, o.city, o.postcode, o.country].filter(Boolean).join(', '), status: 'paid',
      }),
    });
  } catch (e) { console.error('sheet relay failed:', e.message); }
}
/** Called exactly once per order, when it first becomes paid. Never throws. */
function announcePaid(order) {
  Promise.resolve().then(() => mailer.orderPaid(order)).catch(e => console.error('order email failed:', e.message));
  postToSheet(order);
}

// ---- Order helpers -------------------------------------------------------------
/** Marks a pending card order as paid (safe to call many times — only the first call does anything). */
async function markCardPaid(session) {
  const ref = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent && session.payment_intent.id) || session.id;
  const r = await db.query(
    `UPDATE orders SET status='paid', paid_at=now(), updated_at=now(), payment_ref=$2, payment_verified=true, livemode=$3,
            total_pence = COALESCE($4, total_pence),
            customer_email = CASE WHEN customer_email='' THEN $5 ELSE customer_email END
     WHERE stripe_session_id=$1 AND status='pending' RETURNING *`,
    [session.id, ref, !!session.livemode, Number.isInteger(session.amount_total) ? session.amount_total : null,
      str(session.customer_details && session.customer_details.email).toLowerCase()]);
  if (r.rows[0]) {
    const o = r.rows[0];
    await db.event(o.id, 'paid', 'Card payment confirmed by Stripe (' + ref + ')' + (session.livemode ? '' : ' — TEST MODE'));
    // If the customer typed a different delivery address on Stripe's page, keep a note of it.
    const sd = session.shipping_details || (session.collected_information && session.collected_information.shipping_details);
    if (sd && sd.address) {
      const a = sd.address;
      const txt = [sd.name, a.line1, a.line2, a.city, a.postal_code, a.country].filter(Boolean).join(', ');
      const norm = s => String(s || '').replace(/\s+/g, '').toUpperCase();
      if (norm(a.postal_code) !== norm(o.postcode)) {
        await db.query(`UPDATE orders SET flags = trim(flags || ' address-check') WHERE id=$1`, [o.id]);
        o.flags = (o.flags + ' address-check').trim();
        await db.event(o.id, 'note', 'Address entered on the card page differs — please check: ' + txt);
      } else await db.event(o.id, 'note', 'Address on card page: ' + txt);
    }
    announcePaid(o);
    return o;
  }
  const existing = await db.query('SELECT * FROM orders WHERE stripe_session_id=$1', [session.id]);
  if (existing.rows[0]) return existing.rows[0];
  // No order row (e.g. the database was unreachable when checkout started) — rebuild it from Stripe's data.
  return createOrderFromStripe(session, ref);
}
async function createOrderFromStripe(session, ref) {
  let lines = [];
  try {
    const li = await stripe().checkout.sessions.listLineItems(session.id, { limit: 100 });
    lines = li.data.map(x => ({ id: null, name: x.description, pack: null, qty: x.quantity, unit_pence: Math.round(x.amount_total / (x.quantity || 1)), line_pence: x.amount_total }));
  } catch (e) { /* keep empty */ }
  const md = session.metadata || {};
  try {
    const o = await db.createOrder({
      status: 'paid', payment_method: 'card', payment_ref: ref, payment_verified: true, livemode: !!session.livemode,
      stripe_session_id: session.id, paid_at: new Date(),
      customer_name: str(md.delivery_name || (session.customer_details && session.customer_details.name)),
      customer_email: str(session.customer_details && session.customer_details.email).toLowerCase(),
      customer_phone: str(md.delivery_phone, 40), address: str(md.delivery_address, 300), city: str(md.delivery_city, 100),
      postcode: str(md.delivery_postcode, 20), country: str(md.delivery_country, 80), customer_notes: str(md.delivery_notes, 500),
      items: lines, subtotal_pence: session.amount_subtotal || session.amount_total || 0, total_pence: session.amount_total || 0,
      promo_code: str(md.promo_code, 40),
    });
    await db.event(o.id, 'paid', 'Order rebuilt from Stripe payment ' + ref);
    announcePaid(o);
    return o;
  } catch (e) {
    if (e.code === '23505') return (await db.query('SELECT * FROM orders WHERE stripe_session_id=$1', [session.id])).rows[0];
    throw e;
  }
}
/** What the customer is allowed to see about their own order. */
function publicOrder(o) {
  return {
    order_no: o.order_no, status: o.status === 'pending' ? 'awaiting payment' : o.status, placed: o.created_at,
    dispatched: o.dispatched_at, method: o.payment_method,
    items: (o.items || []).map(i => ({ name: i.name, pack: i.pack, qty: i.qty, line: i.line_pence / 100 })),
    discount: o.discount_pence / 100, code: o.promo_code, total: o.total_pence / 100,
    tracking_courier: o.tracking_courier, tracking_number: o.tracking_number, email: o.customer_email,
  };
}

// =================================================================================
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---- Stripe webhook: needs the RAW body, so mount BEFORE express.json() --------
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe().webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send('Webhook signature verification failed');
  }
  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const s = event.data.object;
      if (s.payment_status === 'paid' && db.ready) await markCardPaid(s);
    } else if (event.type === 'charge.refunded' && db.ready) {
      const c = event.data.object;
      if (c.refunded && c.payment_intent) {
        const r = await db.query(`UPDATE orders SET status='refunded', updated_at=now() WHERE payment_ref=$1 AND status<>'refunded' RETURNING id`, [c.payment_intent]);
        if (r.rows[0]) await db.event(r.rows[0].id, 'status', 'Refunded in Stripe');
      }
    }
  } catch (e) {
    console.error('stripe webhook handling failed:', e.message);
    return res.status(500).send('temporary error'); // Stripe will retry
  }
  res.json({ received: true });
});

// Everything else uses parsed JSON.
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!req.path.startsWith('/admin') && ALLOWED_ORIGINS.includes(origin)) res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();
  next();
});

function limiter(max, windowMs) {
  const HITS = new Map();
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const rec = HITS.get(ip) || { count: 0, reset: now + windowMs };
    if (now > rec.reset) { rec.count = 0; rec.reset = now + windowMs; }
    rec.count++;
    HITS.set(ip, rec);
    if (HITS.size > 5000) { for (const [k, v] of HITS) if (now > v.reset) HITS.delete(k); }
    if (rec.count > max) return res.status(429).json({ error: 'Too many requests — please wait a moment and try again.' });
    next();
  };
}
const rateLimit = limiter(30, 60 * 1000);
const trackLimit = limiter(12, 60 * 1000);
const loginLimit = limiter(8, 15 * 60 * 1000);

app.get('/', (req, res) => {
  res.send('<div style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center">' +
    '<h2>NaturalJuices shop server ✅</h2>' +
    '<p>This machine handles payments and the order book behind the scenes — it has no shop pages.</p>' +
    '<p><a href="' + SHOP_URL + '">Go to the NaturalJuices shop →</a> &nbsp;·&nbsp; <a href="/admin">Staff order dashboard</a></p></div>');
});
app.get('/health', (req, res) => res.json({ ok: true, database: db.ready, emails: mailer.enabled }));

// ---- PayPal ---------------------------------------------------------------------
const PAYPAL_API = process.env.PAYPAL_API || 'https://api-m.paypal.com';
const paypalConfigured = () => !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET);
let _ppTok = null;
async function paypalToken() {
  if (_ppTok && _ppTok.exp > Date.now()) return _ppTok.token;
  const auth = Buffer.from(process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_SECRET).toString('base64');
  const r = await fetch(PAYPAL_API + '/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('PayPal login failed');
  _ppTok = { token: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in || 300) - 120) * 1000 };
  return _ppTok.token;
}
/** Asks PayPal about an order. Returns {found, completed, pence, captureId, payer} or throws if PayPal can't be reached. */
async function paypalLookup(orderId) {
  const token = await paypalToken();
  const r = await fetch(PAYPAL_API + '/v2/checkout/orders/' + encodeURIComponent(orderId), { headers: { 'Authorization': 'Bearer ' + token } });
  if (r.status === 404) return { found: false };
  if (!r.ok) throw new Error('PayPal lookup failed (' + r.status + ')');
  const j = await r.json();
  const pu = (j.purchase_units || [])[0] || {};
  const cap = ((pu.payments || {}).captures || [])[0] || {};
  const amt = cap.amount || pu.amount || {};
  return {
    found: true,
    completed: j.status === 'COMPLETED' && (!cap.status || cap.status === 'COMPLETED' || cap.status === 'PENDING'),
    currency: amt.currency_code, pence: Math.round(parseFloat(amt.value || '0') * 100), captureId: cap.id || '',
    payer: j.payer || {},
  };
}
async function verifyPaypalWebhook(req) {
  try {
    const token = await paypalToken();
    const r = await fetch(PAYPAL_API + '/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_algo: req.headers['paypal-auth-algo'],
        cert_url: req.headers['paypal-cert-url'],
        transmission_id: req.headers['paypal-transmission-id'],
        transmission_sig: req.headers['paypal-transmission-sig'],
        transmission_time: req.headers['paypal-transmission-time'],
        webhook_id: process.env.PAYPAL_WEBHOOK_ID,
        webhook_event: req.body,
      }),
    });
    return (await r.json()).verification_status === 'SUCCESS';
  } catch (e) { return false; }
}
app.post('/webhook/paypal', async (req, res) => {
  const ok = await verifyPaypalWebhook(req);
  if (!ok) return res.status(400).send('unverified');
  const ev = req.body || {};
  try {
    if (ev.event_type === 'PAYMENT.CAPTURE.COMPLETED' && db.ready) {
      const c = ev.resource || {};
      const ppOrderId = (((c.supplementary_data || {}).related_ids || {}).order_id) || '';
      const pence = Math.round(parseFloat((c.amount && c.amount.value) || '0') * 100);
      if (ppOrderId) {
        const r = await db.query(
          `UPDATE orders SET payment_verified=true, payment_ref=$2, updated_at=now(),
                  flags = trim(replace(flags, 'unverified', ''))
           WHERE paypal_order_id=$1 RETURNING id, payment_verified`, [ppOrderId, c.id || '']);
        if (r.rows[0]) await db.event(r.rows[0].id, 'note', 'Payment confirmed by PayPal (' + (c.id || '') + ')');
        else {
          // Payment arrived but the browser never told us the basket (tab closed?). Record what PayPal knows.
          try {
            const o = await db.createOrder({
              status: 'paid', payment_method: 'paypal', payment_ref: c.id || '', payment_verified: true, livemode: true,
              paypal_order_id: ppOrderId, paid_at: new Date(), items: [], subtotal_pence: pence, total_pence: pence, flags: 'details-missing',
            });
            await db.event(o.id, 'paid', 'PayPal payment received — basket details not yet received from the shop page; check PayPal for the items and address.');
          } catch (e) { if (e.code !== '23505') throw e; }
        }
      }
    } else if (ev.event_type === 'PAYMENT.CAPTURE.REFUNDED' && db.ready) {
      const links = ((ev.resource || {}).links || []).filter(l => l.rel === 'up');
      const capId = links[0] ? String(links[0].href).split('/').pop() : '';
      if (capId) {
        const r = await db.query(`UPDATE orders SET status='refunded', updated_at=now() WHERE payment_ref=$1 AND status<>'refunded' RETURNING id`, [capId]);
        if (r.rows[0]) await db.event(r.rows[0].id, 'status', 'Refunded in PayPal');
      }
    }
  } catch (e) {
    console.error('paypal webhook handling failed:', e.message);
    return res.status(500).send('temporary error');
  }
  res.json({ received: true });
});

/** The shop page calls this right after a PayPal payment is captured, so the order lands in the order book. */
app.post('/orders/paypal', rateLimit, async (req, res) => {
  try {
    if (!db.ready) return res.status(503).json({ error: 'Order book unavailable', retry: true });
    const { paypalOrderId, items, customer, promo } = req.body || {};
    if (typeof paypalOrderId !== 'string' || !/^[A-Za-z0-9-]{8,40}$/.test(paypalOrderId)) throw new Error('Bad PayPal reference');
    const existing = (await db.query('SELECT * FROM orders WHERE paypal_order_id=$1', [paypalOrderId])).rows[0];
    if (existing && !/details-missing/.test(existing.flags)) return res.json({ order: publicOrder(existing) });

    const b = priceBasket(items, promo, false);
    const cust = cleanCustomer(customer);
    let verified = false, flags = [], paid = b.total, ref = paypalOrderId, note = '';
    if (paypalConfigured()) {
      let pp;
      try { pp = await paypalLookup(paypalOrderId); }
      catch (e) { return res.status(503).json({ error: 'Could not reach PayPal to confirm the payment', retry: true }); }
      if (!pp.found || !pp.completed) return res.status(400).json({ error: 'PayPal has no completed payment with that reference' });
      verified = true; ref = pp.captureId || paypalOrderId; paid = pp.pence;
      if (pp.currency && pp.currency !== 'GBP') flags.push('amount-mismatch');
      if (Math.abs(pp.pence - b.total) > 2) {
        flags.push('amount-mismatch');
        note = 'PayPal received £' + (pp.pence / 100).toFixed(2) + ' but the basket adds up to £' + (b.total / 100).toFixed(2) + ' — please check before sending.';
      }
      if (!cust.customer_email && pp.payer.email_address) cust.customer_email = String(pp.payer.email_address).toLowerCase();
    } else flags.push('unverified');

    let order;
    if (existing) { // the PayPal webhook got here first — fill in the basket and customer details
      const r = await db.query(
        `UPDATE orders SET customer_name=$2, customer_email=$3, customer_phone=$4, address=$5, city=$6, postcode=$7, country=$8,
                customer_notes=$9, items=$10, subtotal_pence=$11, discount_pence=$12, promo_code=$13, updated_at=now(),
                flags=$14 WHERE id=$1 RETURNING *`,
        [existing.id, cust.customer_name, cust.customer_email, cust.customer_phone, cust.address, cust.city, cust.postcode, cust.country,
          cust.customer_notes, JSON.stringify(itemsForDb(b.lines)), b.subtotal, b.discount, b.code,
          (Math.abs(existing.total_pence - b.total) > 2 ? 'amount-mismatch' : '')]);
      order = r.rows[0];
      await db.event(order.id, 'note', 'Basket and delivery details received from the shop page.');
    } else {
      try {
        order = await db.createOrder(Object.assign({
          status: 'paid', payment_method: 'paypal', payment_ref: ref, payment_verified: verified, livemode: true,
          paypal_order_id: paypalOrderId, paid_at: new Date(), items: itemsForDb(b.lines),
          subtotal_pence: b.subtotal, discount_pence: b.discount, total_pence: paid, promo_code: b.code, flags: flags.join(' '),
        }, cust));
      } catch (e) {
        if (e.code === '23505') { // two requests at once — the other one won
          const o = (await db.query('SELECT * FROM orders WHERE paypal_order_id=$1', [paypalOrderId])).rows[0];
          return res.json({ order: publicOrder(o) });
        }
        throw e;
      }
      await db.event(order.id, 'paid', verified ? 'PayPal payment confirmed with PayPal (' + ref + ')'
        : 'PayPal payment reported by the shop page (' + paypalOrderId + ') — not yet confirmed with PayPal, check your PayPal account before sending.');
      if (note) await db.event(order.id, 'note', note);
    }
    announcePaid(order);
    res.json({ order: publicOrder(order) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Card checkout -----------------------------------------------------------------
app.post('/create-checkout-session', rateLimit, async (req, res) => {
  try {
    const { items, customer, successUrl, cancelUrl, promo } = req.body || {};
    const b = priceBasket(items, promo, true);
    const cust = cleanCustomer(customer);

    let line_items;
    if (!b.rate) {
      line_items = b.lines.map(l => ({ price_data: { currency: 'gbp', product_data: { name: l.label.slice(0, 250) }, unit_amount: l.unit_pence }, quantity: l.qty }));
    } else {
      // Spread the discount over the lines so the pennies add up exactly.
      const exact = b.lines.map(l => l.line_pence * (1 - b.rate));
      const pence = exact.map(x => Math.round(x));
      pence[pence.length - 1] += b.total - pence.reduce((a, x) => a + x, 0);
      line_items = b.lines.map((l, ix) => ({ price_data: { currency: 'gbp', product_data: { name: (l.label + (l.qty > 1 ? ' × ' + l.qty : '') + ' (' + b.code + ' applied)').slice(0, 250) }, unit_amount: pence[ix] }, quantity: 1 }));
    }

    // Save the order first (as "pending") so nothing is lost if the customer's browser never comes back.
    let order = null;
    if (db.ready) {
      try {
        order = await db.createOrder(Object.assign({
          status: 'pending', payment_method: 'card', items: itemsForDb(b.lines),
          livemode: !/^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY || ''),
          subtotal_pence: b.subtotal, discount_pence: b.discount, total_pence: b.total, promo_code: b.code,
        }, cust));
      } catch (e) { console.error('could not save pending order:', e.message); }
    }

    // After paying, Stripe sends the customer back with ?session_id=… so the shop can show the order number.
    let success = safeReturnUrl(successUrl, SHOP_URL + '/#/checkout/success');
    const hashAt = success.indexOf('#');
    const base = hashAt < 0 ? success : success.slice(0, hashAt), hash = hashAt < 0 ? '' : success.slice(hashAt);
    success = base + (base.includes('?') ? '&' : '?') + 'session_id={CHECKOUT_SESSION_ID}' + hash;

    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      line_items,
      customer_email: cust.customer_email || undefined,
      client_reference_id: order ? order.order_no : undefined,
      shipping_address_collection: { allowed_countries: ['GB'] },
      metadata: {
        order_no: order ? order.order_no : '',
        delivery_name: cust.customer_name, delivery_address: cust.address, delivery_city: cust.city,
        delivery_postcode: cust.postcode, delivery_country: cust.country, delivery_phone: cust.customer_phone,
        delivery_notes: cust.customer_notes.slice(0, 480), promo_code: b.code,
      },
      payment_intent_data: order ? { description: 'NaturalJuices order ' + order.order_no, metadata: { order_no: order.order_no } } : undefined,
      success_url: success,
      cancel_url: safeReturnUrl(cancelUrl, SHOP_URL + '/#/checkout'),
    });
    if (order) {
      await db.query('UPDATE orders SET stripe_session_id=$2, livemode=$3 WHERE id=$1', [order.id, session.id, session.livemode !== false && order.livemode])
        .catch(e => console.error('could not link session to order:', e.message));
    }
    res.json({ url: session.url, order_no: order ? order.order_no : null });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** The shop's "thank you" page calls this with the session id Stripe handed back. */
app.post('/orders/confirm', rateLimit, async (req, res) => {
  try {
    const id = (req.body || {}).session_id;
    if (typeof id !== 'string' || !/^cs_[A-Za-z0-9_]{10,200}$/.test(id)) throw new Error('Bad session reference');
    const session = await stripe().checkout.sessions.retrieve(id);
    if (session.payment_status !== 'paid') return res.json({ paid: false });
    if (!db.ready) return res.json({ paid: true, order: null });
    const order = await markCardPaid(session);
    res.json({ paid: true, order: order ? publicOrder(order) : null });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Customer order lookup: needs BOTH the order number and the email used at checkout. */
app.post('/orders/track', trackLimit, async (req, res) => {
  try {
    if (!db.ready) return res.status(503).json({ error: 'Order tracking is temporarily unavailable — please call or email us.' });
    const no = str((req.body || {}).order_no, 30).toUpperCase().replace(/\s+/g, '');
    const email = str((req.body || {}).email).toLowerCase();
    if (!no || !email) throw new Error('Please enter your order number and email address.');
    const orderNo = /^\d+$/.test(no) ? 'NJ-' + no : no.replace(/^NJ(\d)/, 'NJ-$1');
    const r = await db.query(`SELECT * FROM orders WHERE order_no=$1 AND lower(customer_email)=$2 AND status<>'pending'`, [orderNo, email]);
    if (!r.rows[0]) return res.status(404).json({ error: 'We couldn’t find an order with that number and email address. Please check both and try again.' });
    const o = publicOrder(r.rows[0]); delete o.email;
    res.json({ order: o });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// =================================================================================
// ADMIN DASHBOARD
// =================================================================================
const ADMIN_HTML = fs.readFileSync(__dirname + '/admin.html', 'utf8');
const adminEnabled = () => !!process.env.ADMIN_PASSWORD;
const sessionSecret = () => process.env.SESSION_SECRET || crypto.createHash('sha256').update('nj-admin|' + process.env.ADMIN_PASSWORD).digest('hex');
const sign = v => crypto.createHmac('sha256', sessionSecret()).update(v).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const SESSION_HOURS = 12;
function isAdmin(req) {
  if (!adminEnabled()) return false;
  const m = /(?:^|;\s*)nj_admin=(\d+)\.([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return !!m && +m[1] > Date.now() && safeEq(sign(m[1]), m[2]);
}
function requireAdmin(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!adminEnabled()) return res.status(503).json({ error: 'Dashboard password has not been set (ADMIN_PASSWORD).' });
  if (!isAdmin(req)) return res.status(401).json({ error: 'Please sign in.' });
  if (req.method !== 'GET' && !/^application\/json/.test(req.headers['content-type'] || '')) return res.status(415).json({ error: 'Unsupported request' });
  if (!db.ready) return res.status(503).json({ error: 'The order database is not connected: ' + db.error });
  next();
}
app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
  res.type('html').send(ADMIN_HTML);
});
app.get('/admin/api/session', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ signedIn: isAdmin(req), passwordSet: adminEnabled(), database: db.ready, databaseError: db.ready ? '' : db.error,
    emails: mailer.enabled, paypalVerify: paypalConfigured(), testMode: /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY || '') });
});
app.post('/admin/api/login', loginLimit, (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!adminEnabled()) return res.status(503).json({ error: 'Dashboard password has not been set (ADMIN_PASSWORD).' });
  if (!safeEq(sign('pw|' + String((req.body || {}).password || '')), sign('pw|' + process.env.ADMIN_PASSWORD))) {
    return res.status(401).json({ error: 'Wrong password.' });
  }
  const exp = String(Date.now() + SESSION_HOURS * 3600 * 1000);
  const secure = req.secure ? '; Secure' : '';
  res.set('Set-Cookie', `nj_admin=${exp}.${sign(exp)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${secure}`);
  res.json({ ok: true });
});
app.post('/admin/api/logout', (req, res) => {
  res.set('Set-Cookie', 'nj_admin=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});

const LIST_COLS = `id, order_no, created_at, status, payment_method, payment_verified, livemode, customer_name, customer_email,
  postcode, total_pence, items, tracking_number, flags`;
function orderFilter(q) {
  const where = [], params = [];
  const status = str(q.status, 20);
  if (status === 'open') where.push(`status IN ('paid','processing')`);
  else if (status && status !== 'all' && db.STATUSES.includes(status)) { params.push(status); where.push(`status = $${params.length}`); }
  else if (status !== 'all') where.push(`status <> 'pending'`);
  const search = str(q.q, 100);
  if (search) {
    params.push('%' + search.replace(/[%_\\]/g, m => '\\' + m) + '%');
    const n = params.length;
    where.push(`(order_no ILIKE $${n} OR customer_name ILIKE $${n} OR customer_email ILIKE $${n} OR postcode ILIKE $${n}
      OR customer_phone ILIKE $${n} OR tracking_number ILIKE $${n} OR payment_ref ILIKE $${n} OR items::text ILIKE $${n})`);
  }
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (day.test(q.from || '')) { params.push(q.from); where.push(`(created_at AT TIME ZONE 'Europe/London')::date >= $${params.length}::date`); }
  if (day.test(q.to || '')) { params.push(q.to); where.push(`(created_at AT TIME ZONE 'Europe/London')::date <= $${params.length}::date`); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}
app.get('/admin/api/orders', requireAdmin, async (req, res) => {
  try {
    const f = orderFilter(req.query);
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const [rows, count] = await Promise.all([
      db.query(`SELECT ${LIST_COLS} FROM orders ${f.sql} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, f.params),
      db.query(`SELECT count(*)::int AS n, COALESCE(sum(total_pence),0)::int AS pence FROM orders ${f.sql}`, f.params),
    ]);
    res.json({ orders: rows.rows, total: count.rows[0].n, sum_pence: count.rows[0].pence, limit, offset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/admin/api/summary', requireAdmin, async (req, res) => {
  try {
    const paid = `livemode AND status IN ('paid','processing','dispatched','delivered')`; // test-card orders never count
    const d = `(created_at AT TIME ZONE 'Europe/London')::date`;
    const today = `(now() AT TIME ZONE 'Europe/London')::date`;
    const r = await db.query(`SELECT
      count(*) FILTER (WHERE livemode AND status IN ('paid','processing'))::int AS to_send,
      count(*) FILTER (WHERE status='pending')::int AS pending,
      count(*) FILTER (WHERE ${paid} AND flags <> '')::int AS flagged,
      count(*) FILTER (WHERE ${paid} AND ${d} = ${today})::int AS today_n,
      COALESCE(sum(total_pence) FILTER (WHERE ${paid} AND ${d} = ${today}),0)::int AS today_pence,
      count(*) FILTER (WHERE ${paid} AND ${d} > ${today} - 7)::int AS week_n,
      COALESCE(sum(total_pence) FILTER (WHERE ${paid} AND ${d} > ${today} - 7),0)::int AS week_pence,
      count(*) FILTER (WHERE ${paid} AND ${d} > ${today} - 30)::int AS month_n,
      COALESCE(sum(total_pence) FILTER (WHERE ${paid} AND ${d} > ${today} - 30),0)::int AS month_pence,
      count(*) FILTER (WHERE ${paid})::int AS all_n,
      COALESCE(sum(total_pence) FILTER (WHERE ${paid}),0)::int AS all_pence
      FROM orders`);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/admin/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const o = (await db.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
    if (!o) return res.status(404).json({ error: 'Order not found' });
    const ev = await db.query('SELECT at, type, detail FROM order_events WHERE order_id=$1 ORDER BY at, id', [id]);
    res.json({ order: o, events: ev.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/admin/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cur = (await db.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Order not found' });
    const b = req.body || {};
    const set = [], params = [id], notes = [];
    const put = (col, val) => { params.push(val); set.push(`${col}=$${params.length}`); };
    if (b.status !== undefined && b.status !== cur.status) {
      if (!db.STATUSES.includes(b.status)) throw new Error('Unknown status');
      put('status', b.status);
      if (b.status === 'dispatched' && !cur.dispatched_at) set.push('dispatched_at=now()');
      if (b.status !== 'pending' && !cur.paid_at && ['paid', 'processing', 'dispatched', 'delivered'].includes(b.status)) set.push('paid_at=now()');
      notes.push(['status', 'Status changed: ' + cur.status + ' → ' + b.status]);
    }
    for (const [key, max, label] of [['tracking_courier', 60, 'Courier'], ['tracking_number', 80, 'Tracking number'], ['admin_notes', 2000, 'Staff note'],
      ['customer_name', 200, 'Name'], ['customer_email', 200, 'Email'], ['customer_phone', 40, 'Phone'], ['address', 300, 'Address'],
      ['city', 100, 'City'], ['postcode', 20, 'Postcode'], ['country', 80, 'Country']]) {
      if (b[key] !== undefined && str(b[key], max) !== cur[key]) {
        put(key, key === 'customer_email' ? str(b[key], max).toLowerCase() : str(b[key], max));
        notes.push(['edit', label + ' updated' + (key === 'admin_notes' ? '' : ': ' + str(b[key], 120))]);
      }
    }
    if (b.clear_flags && cur.flags) { put('flags', ''); notes.push(['note', 'Warnings cleared (' + cur.flags + ')']); }
    if (b.payment_verified === true && !cur.payment_verified) { put('payment_verified', true); notes.push(['note', 'Payment marked as checked by staff']); }
    let order = cur;
    if (set.length) {
      order = (await db.query(`UPDATE orders SET ${set.join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`, params)).rows[0];
      for (const [t, d] of notes) await db.event(id, t, d);
    }
    let emailed = false;
    if (b.notify_customer && order.status === 'dispatched') {
      emailed = await mailer.orderDispatched(order);
      await db.event(id, 'email', emailed ? 'Dispatch email sent to ' + order.customer_email : 'Dispatch email could NOT be sent (email is not set up)');
    }
    const ev = await db.query('SELECT at, type, detail FROM order_events WHERE order_id=$1 ORDER BY at, id', [id]);
    res.json({ order, events: ev.rows, emailed });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/admin/api/export.csv', requireAdmin, async (req, res) => {
  try {
    const f = orderFilter(req.query);
    const r = await db.query(`SELECT * FROM orders ${f.sql} ORDER BY created_at DESC, id DESC LIMIT 20000`, f.params);
    const cell = v => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formulas hiding in customer-typed text
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const when = d => d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Europe/London' }) : '';
    const head = ['Order', 'Placed', 'Status', 'Payment', 'Payment ref', 'Payment checked', 'Test order', 'Name', 'Email', 'Phone', 'Address', 'City', 'Postcode',
      'Country', 'Customer note', 'Items', 'Subtotal', 'Discount', 'Total', 'Promo', 'Dispatched', 'Courier', 'Tracking', 'Staff note', 'Warnings'];
    const lines = r.rows.map(o => [o.order_no, when(o.created_at), o.status, o.payment_method, o.payment_ref, o.payment_verified ? 'yes' : 'no', o.livemode ? '' : 'TEST',
      o.customer_name, o.customer_email, o.customer_phone, o.address, o.city, o.postcode, o.country, o.customer_notes,
      (o.items || []).map(i => i.qty + ' x ' + i.name + (i.pack ? ' (' + i.pack + ')' : '')).join('; '),
      (o.subtotal_pence / 100).toFixed(2), (o.discount_pence / 100).toFixed(2), (o.total_pence / 100).toFixed(2), o.promo_code,
      when(o.dispatched_at), o.tracking_courier, o.tracking_number, o.admin_notes, o.flags].map(cell).join(','));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="naturaljuices-orders-' + new Date().toISOString().slice(0, 10) + '.csv"');
    res.send('﻿' + head.map(cell).join(',') + '\r\n' + lines.join('\r\n') + '\r\n');
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Start -------------------------------------------------------------------------
const port = process.env.PORT || 4242;
const server = app.listen(port, () => console.log('NaturalJuices shop server listening on :' + port));
db.init().catch(e => console.error('db init failed:', e.message));
if (!adminEnabled()) console.warn('⚠ ADMIN_PASSWORD not set — the /admin dashboard is locked until it is.');

module.exports = { app, server };
