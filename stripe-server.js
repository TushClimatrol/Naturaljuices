/**
 * NaturalJuices — Stripe Checkout server
 * --------------------------------------
 * Creates Stripe Checkout Sessions for the basket sent by the website.
 * SECURITY: prices are looked up here from catalog.json — client-sent
 * prices are ignored, so nobody can tamper with what they pay.
 *
 * Run locally:   STRIPE_SECRET_KEY=sk_test_... node stripe-server.js
 * Deploy:        any Node host (Render, Railway, Fly.io, a VPS) or adapt
 *                the handler into a Vercel/Netlify serverless function.
 */
const express = require('express');
const fs = require('fs');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const CATALOG = JSON.parse(fs.readFileSync(__dirname + '/catalog.json', 'utf8'));
const byId = Object.fromEntries(CATALOG.map(p => [p.id, p]));

// Look up the authoritative unit price for an item (+ optional pack label)
function unitPrice(item) {
  const p = byId[item.id];
  if (!p) throw new Error('Unknown product id ' + item.id);
  if (p.out) throw new Error(p.name + ' is out of stock');
  if (item.pack) {
    const pk = (p.packs || []).find(x => x[0] === item.pack);
    if (!pk) throw new Error('Unknown pack "' + item.pack + '" for ' + p.name);
    return { price: pk[1], label: p.name + ' — ' + pk[0] };
  }
  return { price: p.price, label: p.name };
}

const app = express();
app.use(express.json());

// CORS — in production, replace * with your shop's domain, e.g. https://www.naturaljuices.co.uk
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();
  next();
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, customer, successUrl, cancelUrl, promo } = req.body;
    if (!Array.isArray(items) || !items.length) throw new Error('Empty basket');

    // Promo codes — keep in sync with the PROMOS list in the website file
    const PROMOS = { 'WELCOME10': 0.10 };
    const rate = promo && PROMOS[promo.toUpperCase ? promo.toUpperCase() : promo] ? PROMOS[promo.toUpperCase()] : 0;

    const line_items = items.map(i => {
      let { price, label } = unitPrice(i);
      if (rate) { price = +(price * (1 - rate)).toFixed(2); label += ' (' + promo.toUpperCase() + ' applied)'; }
      const qty = Math.max(1, Math.min(99, parseInt(i.qty, 10) || 1));
      return {
        price_data: {
          currency: 'gbp',
          product_data: { name: label.slice(0, 250) },
          unit_amount: Math.round(price * 100),
        },
        quantity: qty,
      };
    });

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
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    res.json({ url: session.url });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Optional but recommended before shipping orders: verify payment via webhook.
// Add an endpoint secret from the Stripe dashboard and uncomment:
// app.post('/webhook', express.raw({type:'application/json'}), (req,res)=>{ ... checkout.session.completed ... });

const port = process.env.PORT || 4242;
app.listen(port, () => console.log('Stripe server listening on :' + port));
