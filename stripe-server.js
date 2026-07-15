/**
 * NaturalJuices — Stripe Checkout server (v2)
 * -------------------------------------------
 * Creates Stripe Checkout Sessions for the basket sent by the website.
 * SECURITY: prices are looked up here from catalog.json — client-sent
 * prices are ignored, so nobody can tamper with what they pay.
 *
 * v2 changes:
 *  - Promo discounts now charge EXACTLY what the website basket shows
 *    (10% is applied to the whole basket once, like the site, instead of
 *    per-unit rounding that could drift by a penny or two).
 *  - Customer phone number stored on the payment (metadata.delivery_phone).
 *  - CORS locked to the shop's own domains instead of "*".
 *
 * Run locally:   STRIPE_SECRET_KEY=sk_test_... node stripe-server.js
 */
const express = require('express');
const fs = require('fs');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const CATALOG = JSON.parse(fs.readFileSync(__dirname + '/catalog.json', 'utf8'));
const byId = Object.fromEntries(CATALOG.map(p => [p.id, p]));

// Only these websites may call this server from a browser
const ALLOWED_ORIGINS = [
  'https://naturaljuices-site.onrender.com',
  'https://new.naturaljuices.co.uk',
  'https://naturaljuices.co.uk',
  'https://www.naturaljuices.co.uk',
];

// Look up the authoritative unit price for an item (+ optional pack label)
function unitPrice(item) {
  const p = byId[item.id];
  if (!p) throw new Error('Unknown product id ' + item.id);
  if (p.out) throw new Error(p.name + ' is out of stock');
  if (item.pack) {
    const pk = (p.packs || []).find(x => x[0] === item.pack);
    if (!pk) throw new Error('Unknown pack "' + item.pack + '" for ' + p.name);
    // Pack prices in catalog.json are PER BOTTLE; the pack label carries the
    // bottle count (e.g. "Pack of 4 Bottles" -> 4). Multiply exactly like the
    // website does, so the charge always equals the basket price.
    const m = String(pk[0]).match(/\d+/);
    const bottles = m ? parseInt(m[0], 10) : 1;
    return { price: pk[1] * bottles, label: p.name + ' — ' + pk[0] };
  }
  return { price: p.price, label: p.name };
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();
  next();
});

// Friendly page for anyone visiting this server directly in a browser
app.get('/', (req, res) => {
  res.send('<div style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center">' +
    '<h2>NaturalJuices payment server ✅</h2>' +
    '<p>This machine handles card payments behind the scenes — it has no shop pages.</p>' +
    '<p><a href="https://naturaljuices-site.onrender.com">Go to the NaturalJuices shop →</a></p></div>');
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, customer, successUrl, cancelUrl, promo } = req.body;
    if (!Array.isArray(items) || !items.length) throw new Error('Empty basket');

    // Promo codes — keep in sync with the PROMOS list in the website file
    // (currently none — WELCOME10 retired; add e.g. 'SPRING15': 0.15 to both
    // this file and the website to launch a new code)
    const PROMOS = {};
    const code = promo && promo.toUpperCase ? promo.toUpperCase() : null;
    const rate = code && PROMOS[code] ? PROMOS[code] : 0;

    const clampQty = q => Math.max(1, Math.min(99, parseInt(q, 10) || 1));

    let line_items;
    if (!rate) {
      // No promo: straightforward per-unit pricing (always exact)
      line_items = items.map(i => {
        const { price, label } = unitPrice(i);
        return {
          price_data: {
            currency: 'gbp',
            product_data: { name: label.slice(0, 250) },
            unit_amount: Math.round(price * 100),
          },
          quantity: clampQty(i.qty),
        };
      });
    } else {
      // Promo: mirror the website's maths exactly.
      // The site computes: total = (sum of line prices) minus 10% of the sum,
      // rounded once at the end. We reproduce that, then distribute the pence
      // across lines and absorb any rounding remainder in the last line, so
      // Stripe charges the same figure the basket showed — to the penny.
      const lines = items.map(i => {
        const { price, label } = unitPrice(i);
        const qty = clampQty(i.qty);
        return { label, qty, exact: price * qty * (1 - rate) };
      });
      const targetPence = Math.round(lines.reduce((s, l) => s + l.exact, 0) * 100);
      const pence = lines.map(l => Math.round(l.exact * 100));
      const drift = targetPence - pence.reduce((a, b) => a + b, 0);
      pence[pence.length - 1] += drift;
      line_items = lines.map((l, ix) => ({
        price_data: {
          currency: 'gbp',
          product_data: {
            name: (l.label + (l.qty > 1 ? ' × ' + l.qty : '') + ' (' + code + ' applied)').slice(0, 250),
          },
          unit_amount: pence[ix],
        },
        quantity: 1,
      }));
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
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    res.json({ url: session.url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const port = process.env.PORT || 4242;
app.listen(port, () => console.log('Stripe server listening on :' + port));
