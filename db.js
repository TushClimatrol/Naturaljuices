/**
 * NaturalJuices — order database (PostgreSQL)
 * -------------------------------------------
 * All orders live in one Postgres database, reached through the DATABASE_URL
 * environment variable. Tables are created automatically on first start.
 *
 * If DATABASE_URL is not set the server still runs (card payments keep working)
 * but orders are NOT recorded — db.ready is false and the admin page says so.
 */
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || '';
let pool = null;
const db = { ready: false, error: url ? 'starting' : 'DATABASE_URL is not set' };

const STATUSES = ['pending', 'paid', 'processing', 'dispatched', 'delivered', 'cancelled', 'refunded'];
db.STATUSES = STATUSES;

const SCHEMA = `
CREATE SEQUENCE IF NOT EXISTS order_no_seq START 10001;
CREATE TABLE IF NOT EXISTS orders (
  id                SERIAL PRIMARY KEY,
  order_no          TEXT UNIQUE NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  status            TEXT NOT NULL DEFAULT 'pending',
  payment_method    TEXT NOT NULL,              -- 'card' | 'paypal'
  payment_ref       TEXT,                       -- Stripe payment intent / PayPal capture id
  payment_verified  BOOLEAN NOT NULL DEFAULT false,
  livemode          BOOLEAN NOT NULL DEFAULT true,
  stripe_session_id TEXT UNIQUE,
  paypal_order_id   TEXT UNIQUE,
  customer_name     TEXT NOT NULL DEFAULT '',
  customer_email    TEXT NOT NULL DEFAULT '',
  customer_phone    TEXT NOT NULL DEFAULT '',
  address           TEXT NOT NULL DEFAULT '',
  city              TEXT NOT NULL DEFAULT '',
  postcode          TEXT NOT NULL DEFAULT '',
  country           TEXT NOT NULL DEFAULT '',
  customer_notes    TEXT NOT NULL DEFAULT '',
  items             JSONB NOT NULL DEFAULT '[]', -- [{id,name,pack,qty,unit_pence,line_pence}]
  subtotal_pence    INTEGER NOT NULL DEFAULT 0,
  discount_pence    INTEGER NOT NULL DEFAULT 0,
  total_pence       INTEGER NOT NULL DEFAULT 0,
  promo_code        TEXT NOT NULL DEFAULT '',
  paid_at           TIMESTAMPTZ,
  dispatched_at     TIMESTAMPTZ,
  tracking_courier  TEXT NOT NULL DEFAULT '',
  tracking_number   TEXT NOT NULL DEFAULT '',
  admin_notes       TEXT NOT NULL DEFAULT '',
  flags             TEXT NOT NULL DEFAULT ''     -- e.g. 'amount-mismatch'
);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx  ON orders (status);
CREATE INDEX IF NOT EXISTS orders_email_idx   ON orders (lower(customer_email));
CREATE TABLE IF NOT EXISTS order_events (
  id        SERIAL PRIMARY KEY,
  order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  type      TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events (order_id, at);
`;

db.init = async function init() {
  if (!url) { console.warn('⚠ DATABASE_URL not set — orders will NOT be recorded.'); return; }
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const internal = /@dpg-[a-z0-9]+-a[:/]/.test(url); // Render internal hostname (no TLS needed)
  pool = new Pool({
    connectionString: url,
    ssl: (local || internal || /sslmode=disable/.test(url)) ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', e => console.error('db pool error:', e.message));
  // Retry a few times: on a fresh deploy the database can take a moment to accept connections.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await pool.query(SCHEMA);
      db.ready = true; db.error = '';
      console.log('Order database ready.');
      return;
    } catch (e) {
      db.error = e.message;
      console.error('db init attempt ' + attempt + ' failed:', e.message);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
};

db.query = (text, params) => {
  if (!pool) return Promise.reject(new Error('Order database is not connected'));
  return pool.query(text, params);
};

db.event = (orderId, type, detail) =>
  db.query('INSERT INTO order_events (order_id, type, detail) VALUES ($1,$2,$3)', [orderId, type, String(detail || '').slice(0, 1000)])
    .catch(e => console.error('event log failed:', e.message));

/** Insert a new order. `o` holds column values; returns the full row. */
db.createOrder = async function createOrder(o) {
  const cols = ['status', 'payment_method', 'payment_ref', 'payment_verified', 'livemode', 'stripe_session_id', 'paypal_order_id',
    'customer_name', 'customer_email', 'customer_phone', 'address', 'city', 'postcode', 'country', 'customer_notes',
    'items', 'subtotal_pence', 'discount_pence', 'total_pence', 'promo_code', 'paid_at', 'flags'];
  const used = cols.filter(c => o[c] !== undefined);
  const vals = used.map(c => (c === 'items' ? JSON.stringify(o[c]) : o[c]));
  const r = await db.query(
    `INSERT INTO orders (order_no, ${used.join(', ')})
     VALUES ('NJ-' || nextval('order_no_seq'), ${used.map((_, i) => '$' + (i + 1)).join(', ')})
     RETURNING *`, vals);
  return r.rows[0];
};

db.end = () => (pool ? pool.end() : Promise.resolve());

module.exports = db;
