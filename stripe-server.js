/**
 * NaturalJuices — Stripe Checkout server (v4)
 * -------------------------------------------
 * Creates Stripe Checkout Sessions AND receives Stripe/PayPal webhooks so every
 * paid order is emailed to admin@ and logged to the Google-Sheet order book.
 *
 * ENVIRONMENT VARIABLES (set in Render → Environment):
 *   STRIPE_SECRET_KEY, SHEET_WEBHOOK_URL, SHEET_TOKEN, STRIPE_WEBHOOK_SECRET,
 *   PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_WEBHOOK_ID
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
  res.set('X-Content-Type-Options',
