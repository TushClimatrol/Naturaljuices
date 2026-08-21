/**
 * NaturalJuices — Stripe Checkout server (v4)
 * -------------------------------------------
 * Creates Stripe Checkout Sessions AND receives Stripe/PayPal webhooks so every
 * paid order is emailed to admin@ and logged to the Google-Sheet order book.
 *
 * SECURITY: prices are looked up here from catalog.json — client-sent prices are
 * ignored. CORS locked to the shop's domains. Return URLs validated. Rate limited.
 *
 * ENVIRONMENT VARIABLES (set these in Render → Environment):
 *   STRIPE_SECRET_KEY       (already set)  — your rk_live_ restricted key
 *   SHEET_WEBHOOK_URL       — the Google Apps Script web-app URL (order book + email)
 *   SHEET_TOKEN             — shared secret; must equal SHARED_TOKEN in the Apps Script
 *   STRIPE_WEBHOOK_SECRET   — the signing secret Stripe shows when you add the webhook
 *   PAYPAL_CLIENT_ID        — PayPal REST app client id  (for verifying PayPal webhooks)
 *   PAYPAL_SECRET           — PayPal REST app secret
 *   PAYPAL_WEBHOOK_ID       — the webhook id PayPal shows when you add the webhook
 */
const express = require('express');
const fs = require('fs');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const CATALOG = JSON.parse(fs.readFileSync(__dirname + '/catalog.json', 'utf8'));
const byId = Object.fromEntries(CATALOG.map(p => [p.id, p]));

const ALLOWED_ORIGINS = [
  'https://naturaljuices-site.onrender.com',
  'https://new.naturaljuices.co.uk',
  'https://naturaljuices.co.uk',
  'https://www.naturaljuices.co.uk',
];
const ALLOWED_RETURN_PREFIXES = ALLOWED_ORIGINS.slice();
function safeReturnUrl(url, fallback) {
  if (typeof url === 'string' && ALLOWED_RETURN_PREFIXES.some(p => url.startsWith(p + '/') || url === p)) return url;
  return fallback;
}

function unitPrice(item) {
  const p = byId[item.id];
  if (!p) throw new Error('Unknown product id ' + item.id);
  if (p.out) throw new Error(p.name + ' is out of stock');
  if (item.pack) {
    const pk = (p.packs || []).find(x => x[0] === item.pack);
    if (!pk) throw new Error('Unknown pack "' + item.pack + '" for ' + p.name);
    const m = String(pk[0]).match(/\d+/);
    const bottles = m ? parseInt(m[0], 10) : 1;
    return { price: pk[1] * bottles, label: p.name + ' — ' + pk[0] };
  }
  return { price: p.price, label: p.name };
}

// ---- Order book / email relay ------------------------------------------------
// POSTs a finished order to the Google Apps Script, which logs it + emails admin@.
async function postOrder(order) {
  if (!process.env.SHEET_WEBHOOK_URL) return;
  try {
    order.token = process.env.SHEET_TOKEN || '';
    await fetch(process.env.SHEET_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    });
  } catch (e) { console.error('order book post failed:', e.message); }
}

const app = express();
app.set('trust proxy', 1);

// ---- Stripe webhook: needs the RAW body, so mount BEFORE express.json() ------
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send('Webhook signature verification failed');
  }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    let items = '';
    try {
      const li = await stripe.checkout.sessions.listLineItems(s.id, { limit: 50 });
      items = li.data.map(x => x.quantity + '× ' + x.description).join(', ');
    } catch (e) {}
    const md = s.metadata || {};
    await postOrder({
      source: 'Stripe',
      ref: s.id,
      name: (s.customer_details && s.customer_details.name) || md.delivery_name || '',
      email: (s.customer_details && s.customer_details.email) || '',
      phone: md.delivery_phone || '',
      amount: (s.amount_total / 100).toFixed(2),
      items: items,
      address: [md.delivery_address, md.delivery_city, md.delivery_postcode].filter(Boolean).join(', '),
      status: 'paid',
    });
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
  if (ALLOWED_ORIGINS.includes(origin)) res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();
  next();
});

const HITS = new Map();
const RL_WINDOW = 60 * 1000, RL_MAX = 30;
function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const rec = HITS.get(ip) || { count: 0, reset: now + RL_WINDOW };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + RL_WINDOW; }
  rec.count++;
  HITS.set(ip, rec);
  if (HITS.size > 5000) { for (const [k, v] of HITS) if (now > v.reset) HITS.delete(k); }
  if (rec.count > RL_MAX) return res.status(429).json({ error: 'Too many requests — please wait a moment and try again.' });
  next();
}

app.get('/', (req, res) => {
  res.send('<div style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center">' +
    '<h2>NaturalJuices payment server ✅</h2>' +
    '<p>This machine handles card payments behind the scenes — it has no shop pages.</p>' +
    '<p><a href="https://naturaljuices-site.onrender.com">Go to the NaturalJuices shop →</a></p></div>');
});

// ---- PayPal webhook: verify with PayPal, then log the order ------------------
const PAYPAL_API = 'https://api-m.paypal.com';
async function paypalToken() {
  const auth = Buffer.from(process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_SECRET).toString('base64');
  const r = await fetch(PAYPAL_API + '/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  return (await r.json()).access_token;
}
async function verifyPaypal(req) {
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
  const ok = await verifyPaypal(req);
  if (!ok) return res.status(400).send('unverified');
  const ev = req.body || {};
  if (ev.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    const c = ev.resource || {};
    const payer = c.payer || {};
    await postOrder({
      source: 'PayPal',
      ref: c.id || (ev.resource && ev.resource.invoice_id) || '',
      name: (payer.name ? [payer.name.given_name, payer.name.surname].filter(Boolean).join(' ') : ''),
      email: payer.email_address || '',
      phone: '',
      amount: (c.amount && c.amount.value) || '',
      items: '',
      address: '',
      status: 'paid',
    });
  }
  res.json({ received: true });
});

app.post('/create-checkout-session', rateLimit, async (req, res) => {
  try {
    const { items, customer, successUrl, cancelUrl, promo } = req.body;
    if (!Array.isArray(items) || !items.length) throw new Error('Empty basket');
    if (items.length > 100) throw new Error('Too many items');

    const PROMOS = {}; // WELCOME10 retired
    const code = promo && promo.toUpperCase ? promo.toUpperCase() : null;
    const rate = code && PROMOS[code] ? PROMOS[code] : 0;
    const clampQty = q => Math.max(1, Math.min(99, parseInt(q, 10) || 1));

    let line_items;
    if (!rate) {
      line_items = items.map(i => {
        const { price, label } = unitPrice(i);
        return { price_data: { currency: 'gbp', product_data: { name: label.slice(0, 250) }, unit_amount: Math.round(price * 100) }, quantity: clampQty(i.qty) };
      });
    } else {
      const lines = items.map(i => { const { price, label } = unitPrice(i); const qty = clampQty(i.qty); return { label, qty, exact: price * qty * (1 - rate) }; });
      const targetPence = Math.round(lines.reduce((s, l) => s + l.exact, 0) * 100);
      const pence = lines.map(l => Math.round(l.exact * 100));
      pence[pence.length - 1] += targetPence - pence.reduce((a, b) => a + b, 0);
      line_items = lines.map((l, ix) => ({ price_data: { currency: 'gbp', product_data: { name: (l.label + (l.qty > 1 ? ' × ' + l.qty : '') + ' (' + code + ' applied)').slice(0, 250) }, unit_amount: pence[ix] }, quantity: 1 }));
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      customer_email: customer && customer.email ? customer.email : undefined,
      shipping_address_collection: { allowed_countries: ['GB'] },
      metadata: {
        delivery_name: (customer && customer.name) || '',
        delivery_address: (customer && customer.address) || '',
        delivery_city: (customer && customer.city) || '',
        delivery_postcode: (customer && customer.postcode) || '',
        delivery_phone: (customer && customer.phone) || '',
        promo_code: rate ? code : '',
      },
      success_url: safeReturnUrl(successUrl, 'https://naturaljuices-site.onrender.com/#/checkout/success'),
      cancel_url: safeReturnUrl(cancelUrl, 'https://naturaljuices-site.onrender.com/#/checkout'),
    });

    res.json({ url: session.url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const port = process.env.PORT || 4242;
app.listen(port, () => console.log('Stripe server listening on :' + port));
