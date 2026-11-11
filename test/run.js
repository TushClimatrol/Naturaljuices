/* End-to-end test: real server + real Postgres + fake Stripe/PayPal APIs.
   Needs TEST_DATABASE_URL (a throwaway database — its orders tables are wiped). */
const http = require('http');
const { spawn } = require('child_process');
const assert = require('assert');
const Stripe = require('stripe');
const { Client } = require('pg');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('Set TEST_DATABASE_URL'); process.exit(1); }
const PORT = 4311, MOCK = 4312, BASE = 'http://127.0.0.1:' + PORT;
const WH = 'whsec_test_secret';
const sessions = {}; const paypalOrders = {};
const shop = { down: false, catalog: JSON.parse(require('fs').readFileSync(__dirname + '/../catalog.json', 'utf8')) };
let n = 0;

const mock = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    const u = req.url.split('?')[0];
    let m;
    if (req.method === 'GET' && u === '/site/index.html') {
      if (shop.down) { res.writeHead(500); return res.end('down'); }
      const cat = shop.catalog.map(p => Object.assign({ cat: 'x', was: p.price }, p));
      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><script>\nconst CAT = ' + JSON.stringify(cat) + ';\nfoo();</script></html>');
    }
    if (req.method === 'POST' && u === '/v1/checkout/sessions') {
      const p = new URLSearchParams(body); const id = 'cs_test_' + (++n) + 'abcdefghij';
      let total = 0; for (let i = 0; p.has(`line_items[${i}][quantity]`); i++) total += (+p.get(`line_items[${i}][quantity]`)) * (+p.get(`line_items[${i}][price_data][unit_amount]`));
      sessions[id] = { id, object: 'checkout.session', url: 'https://checkout.stripe.test/' + id, livemode: false, payment_status: 'unpaid', amount_total: total, amount_subtotal: total,
        payment_intent: 'pi_test_' + n, success_url: p.get('success_url'), client_reference_id: p.get('client_reference_id'),
        customer_details: { email: p.get('customer_email'), name: 'Card Holder' },
        metadata: { delivery_name: p.get('metadata[delivery_name]'), delivery_postcode: p.get('metadata[delivery_postcode]'), order_no: p.get('metadata[order_no]') },
        shipping_details: { name: 'Card Holder', address: { line1: '1 Other Rd', city: 'Leeds', postal_code: 'LS1 1AA', country: 'GB' } } };
      return send(200, sessions[id]);
    }
    if (req.method === 'GET' && (m = u.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))) return sessions[m[1]] ? send(200, sessions[m[1]]) : send(404, { error: { message: 'No such session' } });
    if (req.method === 'GET' && (m = u.match(/^\/v1\/checkout\/sessions\/([^/]+)\/line_items$/))) return send(200, { object: 'list', data: [{ description: 'Rebuilt item', quantity: 2, amount_total: 3398 }], has_more: false });
    if (u === '/v1/oauth2/token') return send(200, { access_token: 'tok', expires_in: 3600 });
    if (req.method === 'GET' && (m = u.match(/^\/v2\/checkout\/orders\/([^/]+)$/))) return paypalOrders[m[1]] ? send(200, paypalOrders[m[1]]) : send(404, {});
    if (u === '/v1/notifications/verify-webhook-signature') return send(200, { verification_status: JSON.parse(body).webhook_event.__ok ? 'SUCCESS' : 'FAILURE' });
    send(404, { error: { message: 'mock: unknown ' + req.method + ' ' + u } });
  });
});

async function call(method, path, body, headers) {
  const r = await fetch(BASE + path, { method, headers: Object.assign(body && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}, headers || {}),
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined, redirect: 'manual' });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, text, headers: r.headers };
}
function startServer(env) {
  const child = spawn('node', ['stripe-server.js'], { cwd: __dirname + '/..', env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => process.env.VERBOSE && process.stdout.write('[srv] ' + d));
  child.stderr.on('data', d => process.env.VERBOSE && process.stdout.write('[srv!] ' + d));
  return child;
}
async function waitUp(wantDb) {
  for (let i = 0; i < 60; i++) {
    try { const h = await call('GET', '/health'); if (h.json && h.json.ok && (!wantDb || h.json.database)) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}
let passed = 0;
const ok = (cond, name) => { assert.ok(cond, name); passed++; console.log('  ✓ ' + name); };
const stripeEvent = (type, object) => {
  const payload = JSON.stringify({ id: 'evt_' + (++n), object: 'event', type, data: { object } });
  return { payload, sig: Stripe.webhooks.generateTestHeaderString({ payload, secret: WH }) };
};
const customer = { name: 'Jane Tester', email: 'Jane@Example.com', phone: '07700 900123', address: '30 Kings Avenue', city: 'Sunbury', postcode: 'tw16 7qe', country: 'United Kingdom', notes: '=cmd() leave in porch' };

(async () => {
  const pg = new Client({ connectionString: DB }); await pg.connect();
  await pg.query('DROP TABLE IF EXISTS order_events; DROP TABLE IF EXISTS orders; DROP SEQUENCE IF EXISTS order_no_seq');
  await new Promise(r => mock.listen(MOCK, r));
  const common = { PORT, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: MOCK, STRIPE_WEBHOOK_SECRET: WH,
    PAYPAL_API: 'http://127.0.0.1:' + MOCK, MAIL_TEST: '1', ORDER_ALERT_EMAIL: 'shop@example.com', SMTP_HOST: '', SHEET_WEBHOOK_URL: '',
    CATALOG_URL: 'http://127.0.0.1:' + MOCK + '/site/index.html', CATALOG_MAX_AGE_MS: '1' };
  let srv;
  try {
    // ============ 1. No database, no admin password: payments must still work ============
    console.log('Without database / password');
    srv = startServer(Object.assign({}, common, { DATABASE_URL: '', ADMIN_PASSWORD: '', PAYPAL_CLIENT_ID: '', PAYPAL_SECRET: '' }));
    await waitUp(false);
    let r = await call('POST', '/create-checkout-session', { items: [{ id: 1, qty: 2 }], customer, successUrl: 'https://naturaljuices.co.uk/#/checkout/success' });
    ok(r.status === 200 && /^https:\/\/checkout\.stripe\.test\//.test(r.json.url) && r.json.order_no === null, 'card checkout still starts with no database');
    // prices follow the live website
    const noni = shop.catalog.find(p => p.id === 1); const was = JSON.stringify(noni);
    noni.price = 21.5; noni.packs = noni.packs.map(k => k[0] === 'Pack of 2 Bottles' ? [k[0], 40] : k);
    r = await call('POST', '/create-checkout-session', { items: [{ id: 1, qty: 1 }, { id: 1, qty: 1, pack: 'Pack of 2 Bottles' }], customer });
    ok(r.status === 200 && sessions[r.json.url.split('/').pop()].amount_total === 2150 + 4000, 'card checkout uses a price just changed on the website');
    shop.down = true;
    r = await call('POST', '/create-checkout-session', { items: [{ id: 1, qty: 1 }], customer });
    ok(r.status === 200 && sessions[r.json.url.split('/').pop()].amount_total === 2150, 'website unreachable: last known prices still used');
    shop.down = false; Object.assign(noni, JSON.parse(was));
    await call('POST', '/create-checkout-session', { items: [{ id: 1, qty: 1 }], customer });
    r = await call('POST', '/orders/paypal', { paypalOrderId: 'PP1234567890', items: [{ id: 1, qty: 1 }], customer });
    ok(r.status === 503 && r.json.retry === true, 'PayPal recording asks the page to retry later');
    r = await call('GET', '/admin/api/orders'); ok(r.status === 503, 'admin locked when no password set');
    r = await call('POST', '/admin/api/login', { password: '' }); ok(r.status === 503, 'cannot sign in with empty password when none set');
    srv.kill(); await new Promise(r => setTimeout(r, 400));

    // ============ 2. Full setup, PayPal NOT verifiable ============
    console.log('With database (PayPal secret not set)');
    srv = startServer(Object.assign({}, common, { DATABASE_URL: DB, ADMIN_PASSWORD: 'correct horse', PAYPAL_CLIENT_ID: '', PAYPAL_SECRET: '' }));
    await waitUp(true);

    // --- card flow ---
    r = await call('POST', '/create-checkout-session', { items: [{ id: 1, qty: 2 }, { id: 1, qty: 1, pack: 'Pack of 2 Bottles' }], customer, successUrl: 'https://naturaljuices.co.uk/#/checkout/success', cancelUrl: 'https://evil.example/' });
    ok(r.status === 200 && r.json.order_no === 'NJ-10001', 'card checkout creates order NJ-10001');
    const sid = r.json.url.split('/').pop();
    ok(sessions[sid].amount_total === 1999 * 2 + 3699, 'server prices the basket itself (2×19.99 + pack of 2 £36.99)');
    ok(sessions[sid].success_url === 'https://naturaljuices.co.uk/?session_id={CHECKOUT_SESSION_ID}#/checkout/success', 'success URL carries the session id');
    r = await call('POST', '/create-checkout-session', { items: [{ id: 2, qty: 1 }], customer });
    ok(r.status === 400 && /out of stock/.test(r.json.error), 'out-of-stock product refused');
    r = await call('POST', '/create-checkout-session', { items: [{ id: 99999, qty: 1 }], customer }); ok(r.status === 400, 'unknown product refused');
    r = await call('POST', '/orders/confirm', { session_id: sid }); ok(r.json.paid === false, 'unpaid session is not confirmed');
    r = await call('POST', '/orders/track', { order_no: 'NJ-10001', email: 'jane@example.com' }); ok(r.status === 404, 'unpaid order is not trackable');
    sessions[sid].payment_status = 'paid';
    r = await call('POST', '/orders/confirm', { session_id: sid });
    ok(r.json.paid && r.json.order.order_no === 'NJ-10001' && r.json.order.status === 'paid' && r.json.order.total === 76.97, 'paid session confirms the order');
    let ev = stripeEvent('checkout.session.completed', sessions[sid]);
    r = await call('POST', '/webhook/stripe', ev.payload, { 'Content-Type': 'application/json', 'stripe-signature': ev.sig });
    ok(r.status === 200, 'Stripe webhook accepted');
    r = await call('POST', '/orders/confirm', { session_id: sid });
    let q = await pg.query(`SELECT count(*)::int n FROM order_events e JOIN orders o ON o.id=e.order_id WHERE o.order_no='NJ-10001' AND e.type='paid'`);
    ok(q.rows[0].n === 1, 'order marked paid exactly once (webhook + page both reported)');
    r = await call('POST', '/webhook/stripe', ev.payload, { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=bad' }); ok(r.status === 400, 'forged Stripe webhook rejected');
    q = await pg.query(`SELECT * FROM orders WHERE order_no='NJ-10001'`);
    ok(q.rows[0].customer_email === 'jane@example.com' && q.rows[0].postcode === 'TW16 7QE' && q.rows[0].livemode === false && /address-check/.test(q.rows[0].flags), 'customer details saved; test mode + different card-page address flagged');

    // webhook for a session we never saw → rebuilt order
    sessions['cs_test_orphan1234567'] = { id: 'cs_test_orphan1234567', livemode: false, payment_status: 'paid', amount_total: 3398, payment_intent: 'pi_orphan', customer_details: { email: 'x@y.com', name: 'Orphan' }, metadata: { delivery_postcode: 'AB1 2CD' } };
    ev = stripeEvent('checkout.session.completed', sessions['cs_test_orphan1234567']);
    r = await call('POST', '/webhook/stripe', ev.payload, { 'Content-Type': 'application/json', 'stripe-signature': ev.sig });
    q = await pg.query(`SELECT * FROM orders WHERE stripe_session_id='cs_test_orphan1234567'`);
    ok(r.status === 200 && q.rows.length === 1 && q.rows[0].status === 'paid' && q.rows[0].items[0].name === 'Rebuilt item', 'payment with no saved order is rebuilt from Stripe');
    const orphanNo = q.rows[0].order_no;

    // --- PayPal flow (unverified) ---
    r = await call('POST', '/orders/paypal', { paypalOrderId: '5O190127TN364715T', items: [{ id: 2, qty: 3 }], customer });
    ok(r.status === 200 && /^NJ-\d+$/.test(r.json.order.order_no) && r.json.order.total === 71.22, 'PayPal order recorded (even for an item now out of stock)');
    const ppNo = r.json.order.order_no;
    r = await call('POST', '/orders/paypal', { paypalOrderId: '5O190127TN364715T', items: [{ id: 2, qty: 3 }], customer });
    ok(r.json.order.order_no === ppNo, 'same PayPal payment reported twice → one order');
    q = await pg.query(`SELECT * FROM orders WHERE order_no=$1`, [ppNo]);
    ok(q.rows[0].payment_verified === false && q.rows[0].flags === 'unverified', 'unverified PayPal order flagged for a manual check');
    r = await call('POST', '/orders/paypal', { paypalOrderId: "x'; DROP TABLE orders;--", items: [{ id: 1, qty: 1 }], customer }); ok(r.status === 400, 'bad PayPal reference refused');
    r = await call('POST', '/orders/paypal', { paypalOrderId: 'ABCDEFGH12345', items: [], customer }); ok(r.status === 400, 'empty basket refused');

    // --- tracking ---
    r = await call('POST', '/orders/track', { order_no: ' nj-10001 ', email: 'JANE@example.com' });
    ok(r.status === 200 && r.json.order.status === 'paid' && r.json.order.email === undefined, 'customer can track with order number + email');
    r = await call('POST', '/orders/track', { order_no: '10001', email: 'someone@else.com' }); ok(r.status === 404, 'wrong email cannot see the order');

    // --- admin ---
    r = await call('GET', '/admin'); ok(r.status === 200 && /Natural Juices — orders/.test(r.text), 'admin page loads');
    r = await call('GET', '/admin/api/orders'); ok(r.status === 401, 'orders API needs sign-in');
    r = await call('GET', '/admin/api/export.csv'); ok(r.status === 401, 'export needs sign-in');
    r = await call('POST', '/admin/api/login', { password: 'wrong' }); ok(r.status === 401, 'wrong password refused');
    r = await call('GET', '/admin/api/orders', null, { Cookie: 'nj_admin=' + (Date.now() + 1e7) + '.' + 'a'.repeat(64) }); ok(r.status === 401, 'forged cookie refused');
    r = await call('POST', '/admin/api/login', { password: 'correct horse' });
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    ok(r.status === 200 && /HttpOnly/.test(r.headers.get('set-cookie')) && /SameSite=Strict/.test(r.headers.get('set-cookie')), 'correct password signs in (HttpOnly, SameSite cookie)');
    const H = { Cookie: cookie };
    r = await call('GET', '/admin/api/orders?status=open', null, H);
    ok(r.json.total === 3 && r.json.orders[0].order_no === ppNo, '"To send" lists the 3 paid orders, newest first');
    r = await call('GET', '/admin/api/orders?status=pending', null, H); ok(r.json.total === 0, 'no unpaid baskets (the out-of-stock attempt never saved one)');
    r = await call('GET', '/admin/api/orders?q=tw16', null, H); ok(r.json.total === 2, 'search by postcode');
    r = await call('GET', '/admin/api/orders?q=' + encodeURIComponent("%' OR 1=1 --"), null, H); ok(r.status === 200 && r.json.total === 0, 'search is injection-safe');
    r = await call('GET', '/admin/api/summary', null, H);
    ok(r.json.to_send === 1 && r.json.today_n === 1 && r.json.today_pence === 7122 && r.json.flagged === 1, 'summary counts real orders only (test-card orders excluded)');
    const id1 = (await pg.query(`SELECT id FROM orders WHERE order_no='NJ-10001'`)).rows[0].id;
    r = await call('PATCH', '/admin/api/orders/' + id1, { status: 'dispatched', tracking_courier: 'Royal Mail', tracking_number: 'AB123456789GB', notify_customer: true }, H);
    ok(r.status === 200 && r.json.order.status === 'dispatched' && r.json.order.dispatched_at && r.json.emailed === true, 'mark as dispatched with tracking + customer email');
    r = await call('PATCH', '/admin/api/orders/' + id1, { status: 'nonsense' }, H); ok(r.status === 400, 'unknown status refused');
    r = await call('PATCH', '/admin/api/orders/' + id1, 'status=delivered', Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, H)); ok(r.status === 415, 'non-JSON (cross-site form) update refused');
    r = await call('PATCH', '/admin/api/orders/' + id1, { admin_notes: 'Left with neighbour', clear_flags: true }, H);
    ok(r.json.order.flags === '' && r.json.events.some(e => /Status changed: paid → dispatched/.test(e.detail)), 'notes saved, warnings cleared, history kept');
    r = await call('POST', '/orders/track', { order_no: 'NJ-10001', email: 'jane@example.com' });
    ok(r.json.order.status === 'dispatched' && r.json.order.tracking_number === 'AB123456789GB', 'customer sees dispatched + tracking number');
    r = await call('GET', '/admin/api/export.csv?status=all', null, H);
    ok(r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && r.text.split('\r\n').length === 5 && r.text.includes('"\'=cmd() leave in porch"'), 'CSV export has all orders and neutralises formulas');
    r = await call('GET', '/admin/api/orders', null, { Cookie: cookie, Origin: 'https://naturaljuices.co.uk' });
    ok(!r.headers.get('access-control-allow-origin'), 'admin API is not readable cross-site');
    r = await call('POST', '/admin/api/logout', {}, H); ok(/Max-Age=0/.test(r.headers.get('set-cookie')), 'sign out clears cookie');

    // refund webhook
    ev = stripeEvent('charge.refunded', { id: 'ch_1', refunded: true, payment_intent: 'pi_orphan' });
    await call('POST', '/webhook/stripe', ev.payload, { 'Content-Type': 'application/json', 'stripe-signature': ev.sig });
    q = await pg.query(`SELECT status FROM orders WHERE order_no=$1`, [orphanNo]); ok(q.rows[0].status === 'refunded', 'Stripe refund marks the order refunded');
    srv.kill(); await new Promise(r => setTimeout(r, 400));

    // ============ 3. PayPal verifiable ============
    console.log('With PayPal verification');
    srv = startServer(Object.assign({}, common, { DATABASE_URL: DB, ADMIN_PASSWORD: 'correct horse', PAYPAL_CLIENT_ID: 'id', PAYPAL_SECRET: 'sec', PAYPAL_WEBHOOK_ID: 'wh' }));
    await waitUp(true);
    q = await pg.query('SELECT count(*)::int n FROM orders'); ok(q.rows[0].n === 3, 'orders survive a server restart');
    r = await call('POST', '/orders/paypal', { paypalOrderId: 'FAKEFAKEFAKE1', items: [{ id: 1, qty: 1 }], customer });
    ok(r.status === 400, 'made-up PayPal payment is rejected');
    paypalOrders['REALORDER00001'] = { id: 'REALORDER00001', status: 'COMPLETED', payer: { email_address: 'payer@pp.com' }, purchase_units: [{ amount: { currency_code: 'GBP', value: '19.99' }, payments: { captures: [{ id: 'CAP001', status: 'COMPLETED', amount: { currency_code: 'GBP', value: '19.99' } }] } }] };
    r = await call('POST', '/orders/paypal', { paypalOrderId: 'REALORDER00001', items: [{ id: 1, qty: 1 }], customer });
    q = await pg.query(`SELECT * FROM orders WHERE paypal_order_id='REALORDER00001'`);
    ok(r.status === 200 && q.rows[0].payment_verified && q.rows[0].payment_ref === 'CAP001' && q.rows[0].flags === '', 'real PayPal payment verified and recorded');
    paypalOrders['REALORDER00002'] = { id: 'REALORDER00002', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP002', status: 'COMPLETED', amount: { currency_code: 'GBP', value: '1.00' } }] } }] };
    r = await call('POST', '/orders/paypal', { paypalOrderId: 'REALORDER00002', items: [{ id: 1, qty: 1 }], customer });
    q = await pg.query(`SELECT * FROM orders WHERE paypal_order_id='REALORDER00002'`);
    ok(q.rows[0].flags === 'amount-mismatch' && q.rows[0].total_pence === 100, 'underpaid PayPal order flagged, real amount stored');
    // webhook first, page second
    r = await call('POST', '/webhook/paypal', { __ok: true, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP003', amount: { value: '19.99' }, supplementary_data: { related_ids: { order_id: 'REALORDER00003' } } } });
    q = await pg.query(`SELECT * FROM orders WHERE paypal_order_id='REALORDER00003'`);
    ok(r.status === 200 && q.rows[0].flags === 'details-missing', 'PayPal webhook alone still records the payment');
    paypalOrders['REALORDER00003'] = { id: 'REALORDER00003', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP003', status: 'COMPLETED', amount: { currency_code: 'GBP', value: '19.99' } }] } }] };
    r = await call('POST', '/orders/paypal', { paypalOrderId: 'REALORDER00003', items: [{ id: 1, qty: 1 }], customer });
    q = await pg.query(`SELECT * FROM orders WHERE paypal_order_id='REALORDER00003'`);
    ok(q.rows.length === 1 && q.rows[0].flags === '' && q.rows[0].customer_name === 'Jane Tester' && q.rows[0].items.length === 1, '…and the page then fills in the basket (no duplicate)');
    r = await call('POST', '/webhook/paypal', { __ok: false, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'X', supplementary_data: { related_ids: { order_id: 'FORGED0000001' } } } });
    ok(r.status === 400, 'forged PayPal webhook rejected');
    // login throttling
    let last; for (let i = 0; i < 10; i++) last = await call('POST', '/admin/api/login', { password: 'guess' + i });
    ok(last.status === 429, 'password guessing is throttled');
    console.log('\nAll ' + passed + ' checks passed.');
  } catch (e) {
    console.error('\n✗ FAILED:', e.message); process.exitCode = 1;
  } finally {
    if (srv) srv.kill(); mock.close(); await pg.end();
  }
})();
