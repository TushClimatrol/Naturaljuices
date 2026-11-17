/**
 * NaturalJuices — order emails
 * ----------------------------
 * Sends: (1) "new order" alert to the shop, (2) order confirmation to the customer,
 * (3) "your order has been dispatched" to the customer.
 *
 * Switched on by setting these environment variables:
 *   SMTP_HOST   e.g. smtp.mail.yahoo.com
 *   SMTP_PORT   587 (default) or 465
 *   SMTP_USER   the mailbox login
 *   SMTP_PASS   the mailbox (app) password
 *   MAIL_FROM   optional, defaults to "Natural Juices <SMTP_USER>"
 *   ORDER_ALERT_EMAIL  where new-order alerts go (defaults to SMTP_USER)
 * If SMTP_HOST is not set, nothing is sent and nothing breaks.
 *
 * The HTML is written for email clients: tables, inline styles, system fonts, no scripts.
 */
const nodemailer = require('nodemailer');

const enabled = !!process.env.SMTP_HOST || process.env.MAIL_TEST === '1';
let transport = null;
const sent = []; // only filled in MAIL_TEST mode
let products = {}; // id -> {name, img, ...}; set by the server from the live catalogue

function tx() {
  if (transport) return transport;
  if (process.env.MAIL_TEST === '1') transport = nodemailer.createTransport({ jsonTransport: true });
  else {
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 15000, socketTimeout: 20000,
    });
  }
  return transport;
}

// ---- Brand -----------------------------------------------------------------------
const SITE = 'https://naturaljuices.co.uk';
const SERVER = process.env.PUBLIC_URL || 'https://naturaljuices.onrender.com';
const LOGO = SITE + '/assets/email-logo.png';
const C = {
  forest: '#0E2A1B', leaf: '#1F6B3A', leafDark: '#16512B', mint: '#7CF5A8', mintSoft: '#E6F6EC', mintText: '#CFF5DC',
  ink: '#18241D', mute: '#5C6B61', line: '#DCE5DB', bg: '#F2F6F3', card: '#FFFFFF', amber: '#9A5B00', amberSoft: '#FFF3D6',
  berry: '#FF4D7E',
};
const FONT = "'Helvetica Neue',Helvetica,Arial,sans-serif";

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const gbp = p => '£' + (p / 100).toFixed(2);
const FROM = () => process.env.MAIL_FROM || ('Natural Juices <' + (process.env.SMTP_USER || 'contact@naturaljuices.co.uk') + '>');
const SHOP = () => process.env.ORDER_ALERT_EMAIL || process.env.SMTP_USER || '';
const firstName = o => esc((o.customer_name || '').trim().split(/\s+/)[0] || 'there');
const trackUrl = o => SITE + '/#/track?order=' + encodeURIComponent(o.order_no) + '&email=' + encodeURIComponent(o.customer_email || '');
const when = d => d ? new Date(d).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' }) : '';

const COURIERS = {
  'royal mail': n => 'https://www.royalmail.com/track-your-item#/tracking-results/' + encodeURIComponent(n),
  'dpd': n => 'https://www.dpd.co.uk/apps/tracking/?reference=' + encodeURIComponent(n),
  'evri': n => 'https://www.evri.com/track/parcel/' + encodeURIComponent(n),
  'parcelforce': n => 'https://www.parcelforce.com/track-trace?trackNumber=' + encodeURIComponent(n),
  'dhl': n => 'https://www.dhl.com/gb-en/home/tracking.html?tracking-id=' + encodeURIComponent(n),
  'ups': n => 'https://www.ups.com/track?tracknum=' + encodeURIComponent(n),
};
function courierLink(o) {
  const f = COURIERS[String(o.tracking_courier || '').toLowerCase().trim()];
  return f && o.tracking_number ? f(o.tracking_number) : '';
}

// ---- Building blocks ---------------------------------------------------------------
function button(label, href, opts) {
  const dark = opts && opts.dark;
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto"><tr><td align="center" bgcolor="${dark ? C.leaf : C.mint}" style="border-radius:999px;background:${dark ? C.leaf : C.mint}">
    <a href="${esc(href)}" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:15px;font-weight:700;color:${dark ? '#FFFFFF' : C.forest};text-decoration:none;border-radius:999px;letter-spacing:.2px">${label}</a></td></tr></table>`;
}
function progress(step) { // 1 received · 2 packing · 3 dispatched · 4 delivered
  const steps = ['Order received', 'Being packed', 'Dispatched', 'Delivered'];
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0"><tr>` +
    steps.map((s, i) => {
      const n = i + 1, done = n < step, now = n === step;
      const bg = done || now ? C.leaf : '#FFFFFF', fg = done || now ? '#FFFFFF' : C.mute, bd = done || now ? C.leaf : C.line;
      return `<td align="center" valign="top" width="25%" style="padding:0 2px">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto"><tr><td align="center" valign="middle" width="34" height="34" bgcolor="${bg}" style="width:34px;height:34px;border-radius:50%;border:2px solid ${bd};background:${bg};font-family:${FONT};font-size:14px;font-weight:700;color:${fg};line-height:34px">${done ? '&#10003;' : n}</td></tr></table>
        <div style="font-family:${FONT};font-size:12px;line-height:16px;color:${now ? C.ink : C.mute};font-weight:${now ? 700 : 400};margin-top:8px">${s}</div></td>`;
    }).join('') + `</tr></table>`;
}
function thumb(i) {
  const p = i.id != null ? products[i.id] : null;
  const img = p && p.img ? p.img : '';
  if (img) return `<img src="${esc(img)}" width="64" height="64" alt="" style="display:block;width:64px;height:64px;border-radius:12px;object-fit:cover;border:1px solid ${C.line}">`;
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td width="64" height="64" bgcolor="${C.mintSoft}" align="center" valign="middle" style="width:64px;height:64px;border-radius:12px;background:${C.mintSoft};font-size:26px;line-height:64px">&#127807;</td></tr></table>`;
}
function itemsTable(o) {
  const rows = (o.items || []).map(i =>
    `<tr><td width="64" valign="top" style="padding:10px 0">${thumb(i)}</td>
     <td valign="middle" style="padding:10px 12px;font-family:${FONT};font-size:14px;line-height:20px;color:${C.ink}">${esc(i.name)}${i.pack ? `<br><span style="font-size:12px;color:${C.leaf};font-weight:600">${esc(i.pack)}</span>` : ''}<br><span style="font-size:12px;color:${C.mute}">Qty ${i.qty}</span></td>
     <td valign="middle" align="right" style="padding:10px 0;font-family:${FONT};font-size:14px;font-weight:700;color:${C.ink};white-space:nowrap">${gbp(i.line_pence)}</td></tr>`).join('');
  const line = (l, v, bold) => `<tr><td colspan="2" style="padding:6px 0;font-family:${FONT};font-size:${bold ? 16 : 14}px;color:${bold ? C.ink : C.mute};font-weight:${bold ? 700 : 400}">${l}</td><td align="right" style="padding:6px 0;font-family:${FONT};font-size:${bold ? 16 : 14}px;color:${bold ? C.ink : C.mute};font-weight:${bold ? 700 : 400};white-space:nowrap">${v}</td></tr>`;
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}
    <tr><td colspan="3" style="padding:6px 0 10px;border-bottom:1px solid ${C.line}"></td></tr>
    ${o.discount_pence > 0 ? line('Discount' + (o.promo_code ? ' (' + esc(o.promo_code) + ')' : ''), '&minus;' + gbp(o.discount_pence)) : ''}
    ${line('Delivery', '<span style="color:' + C.leaf + ';font-weight:700">FREE</span>')}
    ${line('Total paid', gbp(o.total_pence), true)}</table>`;
}
function addressCard(o, title) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${C.bg}" style="background:${C.bg};border-radius:14px"><tr><td style="padding:16px 18px;font-family:${FONT};font-size:14px;line-height:21px;color:${C.ink}">
    <div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:${C.mute};font-weight:700;margin-bottom:6px">${title}</div>
    ${[o.customer_name, o.address, o.city, o.postcode, o.country].filter(Boolean).map(esc).join('<br>')}</td></tr></table>`;
}
function panel(inner, bg) {
  return `<tr><td style="padding:0 28px 22px">${inner}</td></tr>`;
}
function shell(preheader, headerHtml, bodyRows, opts) {
  const staff = opts && opts.staff;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Natural Juices</title></head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${C.bg}" style="background:${C.bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px">
  <tr><td bgcolor="${C.forest}" align="center" style="background:${C.forest};border-radius:20px 20px 0 0;padding:26px 24px 18px">
    <a href="${SITE}" style="text-decoration:none"><img src="${LOGO}" width="220" alt="Natural Juices — Health Supplements" style="display:block;width:220px;max-width:70%;height:auto;border:0;margin:0 auto"></a>
    ${headerHtml}
  </td></tr>
  <tr><td bgcolor="${C.card}" style="background:${C.card};border-radius:0 0 20px 20px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${bodyRows}</table></td></tr>
  <tr><td align="center" style="padding:22px 16px 0;font-family:${FONT};font-size:12px;line-height:19px;color:${C.mute}">
    ${staff ? '' : `<div style="margin-bottom:10px"><b style="color:${C.ink}">Questions?</b> Reply to this email or call <a href="tel:+442072052477" style="color:${C.leaf};text-decoration:none;font-weight:600">0207 205 2477</a> (9am&ndash;8pm Mon&ndash;Sat).</div>`}
    <div>Natural Juices &amp; Vitamins Ltd &middot; Braemar House, 30 Kings Avenue, Sunbury-on-Thames, TW16 7QE</div>
    <div><a href="${SITE}" style="color:${C.leaf};text-decoration:none">naturaljuices.co.uk</a> &middot; <a href="${SITE}/#/legal/returns" style="color:${C.leaf};text-decoration:none">Returns &amp; refunds</a> &middot; <a href="${SITE}/#/legal/privacy" style="color:${C.leaf};text-decoration:none">Privacy</a></div>
    <div style="margin-top:6px;color:#8C9A90">Company no. 07539535 &middot; Organic certification GB-ORG-04</div>
  </td></tr>
</table></td></tr></table></body></html>`;
}
const h1 = t => `<h1 style="margin:0 0 10px;font-family:${FONT};font-size:26px;line-height:32px;color:${C.ink};font-weight:800;letter-spacing:-.3px">${t}</h1>`;
const p = (t, extra) => `<p style="margin:0 0 ${extra || 14}px;font-family:${FONT};font-size:15px;line-height:23px;color:${C.ink}">${t}</p>`;
const sectionTitle = t => `<div style="font-family:${FONT};font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:${C.mute};font-weight:700;margin:0 0 6px">${t}</div>`;
const headerLine = (label, value) => `<div style="margin-top:16px;font-family:${FONT};font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:${C.mintText};opacity:.85">${label}</div>
  <div style="font-family:${FONT};font-size:22px;font-weight:800;color:${C.mint};letter-spacing:.3px;margin-top:2px">${value}</div>`;

// ---- Messages ---------------------------------------------------------------------------
function confirmationHtml(o) {
  return shell(`Order ${o.order_no} received — ${gbp(o.total_pence)}. We're getting it ready.`,
    headerLine('Order confirmed', esc(o.order_no)),
    panel(`<div style="padding-top:28px">${h1('Thank you, ' + firstName(o) + '!')}
      ${p(`We've received your order and are getting it ready. Orders placed before 2pm Monday&ndash;Friday are despatched the same day, with <b>free UK delivery</b>.`, 20)}
      ${progress(1)}</div>`) +
    panel(`${sectionTitle('Your items')}${itemsTable(o)}`) +
    panel(addressCard(o, 'Delivering to') + (o.customer_notes ? `<div style="font-family:${FONT};font-size:13px;color:${C.mute};margin-top:10px"><b>Your note:</b> ${esc(o.customer_notes)}</div>` : '')) +
    panel(`<div style="text-align:center">${button('Track my order', trackUrl(o))}
      <div style="font-family:${FONT};font-size:12px;color:${C.mute};margin-top:12px">We'll email you again as soon as it's on its way.</div></div>`));
}
function dispatchedHtml(o) {
  const link = courierLink(o);
  const tracking = o.tracking_number ? `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${C.mintSoft}" style="background:${C.mintSoft};border-radius:14px"><tr><td align="center" style="padding:18px 18px 20px">
      ${sectionTitle(esc(o.tracking_courier || 'Courier') + ' tracking number')}
      <div style="font-family:${FONT};font-size:20px;font-weight:800;color:${C.ink};letter-spacing:1px;margin:2px 0 14px">${esc(o.tracking_number)}</div>
      ${link ? button('Track with ' + esc(o.tracking_courier), link, { dark: true }) : ''}</td></tr></table>` : '';
  return shell(`Good news — order ${o.order_no} is on its way to you.`,
    headerLine('On its way', esc(o.order_no)),
    panel(`<div style="padding-top:28px">${h1('Your order is on its way, ' + firstName(o) + '!')}
      ${p(`Order <b>${esc(o.order_no)}</b> left us${o.dispatched_at ? ' on ' + when(o.dispatched_at) : ''}${o.tracking_courier ? ' with ' + esc(o.tracking_courier) : ''} and is heading to you now.`, 20)}
      ${progress(3)}</div>`) +
    (tracking ? panel(tracking) : '') +
    panel(`${sectionTitle("What's in the parcel")}${itemsTable(o)}`) +
    panel(addressCard(o, 'Delivering to')) +
    panel(`<div style="text-align:center">${button('View my order', trackUrl(o))}
      <div style="font-family:${FONT};font-size:12px;color:${C.mute};margin-top:12px">Not in? Most couriers will leave a card or try a neighbour. Give us a call if anything's wrong.</div></div>`));
}
function alertHtml(o) {
  const method = o.payment_method === 'paypal' ? 'PayPal' : 'Card';
  const flags = String(o.flags || '').split(/\s+/).filter(Boolean);
  const warn = [];
  if (!o.livemode) warn.push('TEST order (Stripe test card) — no real money taken.');
  if (!o.payment_verified) warn.push('Payment not yet confirmed with ' + method + ' — check it before sending.');
  if (flags.includes('amount-mismatch')) warn.push('Amount paid does not match the basket — check the dashboard.');
  if (flags.includes('address-check')) warn.push('Customer typed a different address on the card page — see the dashboard.');
  const warnHtml = warn.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${C.amberSoft}" style="background:${C.amberSoft};border-radius:12px;margin-bottom:16px"><tr><td style="padding:12px 16px;font-family:${FONT};font-size:13px;line-height:20px;color:${C.amber}">${warn.map(w => '&#9888; ' + esc(w)).join('<br>')}</td></tr></table>` : '';
  const row = (k, v) => `<tr><td style="padding:4px 0;font-family:${FONT};font-size:13px;color:${C.mute};width:90px">${k}</td><td style="padding:4px 0;font-family:${FONT};font-size:14px;color:${C.ink}">${v}</td></tr>`;
  return shell(`${o.customer_name} — ${gbp(o.total_pence)} by ${method}. ${(o.items || []).length} item line(s).`,
    headerLine('New order', esc(o.order_no) + ' &middot; ' + gbp(o.total_pence)),
    panel(`<div style="padding-top:26px">${warnHtml}${h1('New order from ' + esc(o.customer_name || 'a customer'))}
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
        ${row('Paid by', method + (o.payment_ref ? ` <span style="color:${C.mute};font-size:12px">(${esc(o.payment_ref)})</span>` : ''))}
        ${row('Email', `<a href="mailto:${esc(o.customer_email)}" style="color:${C.leaf}">${esc(o.customer_email)}</a>`)}
        ${row('Phone', esc(o.customer_phone) || '&mdash;')}
        ${row('Placed', esc(new Date(o.created_at || Date.now()).toLocaleString('en-GB', { timeZone: 'Europe/London' })))}
      </table>${o.customer_notes ? `<div style="margin-top:10px;font-family:${FONT};font-size:14px;color:${C.ink}"><b>Customer note:</b> ${esc(o.customer_notes)}</div>` : ''}</div>`) +
    panel(`${sectionTitle('Items to pack')}${itemsTable(o)}`) +
    panel(addressCard(o, 'Deliver to')) +
    panel(`<div style="text-align:center">${button('Open in the orders dashboard', SERVER + '/admin', { dark: true })}</div>`), { staff: true });
}

// ---- Sending ----------------------------------------------------------------------------
async function send(msg) {
  if (!enabled) return false;
  try {
    const info = await tx().sendMail(Object.assign({ from: FROM() }, msg));
    if (process.env.MAIL_TEST === '1') sent.push(JSON.parse(info.message));
    return true;
  } catch (e) { console.error('email failed (' + msg.subject + '):', e.message); return false; }
}
function textFallback(o, intro) {
  return intro + '\n\n' + (o.items || []).map(i => i.qty + ' x ' + i.name + (i.pack ? ' (' + i.pack + ')' : '') + ' - ' + gbp(i.line_pence)).join('\n') +
    '\nTotal: ' + gbp(o.total_pence) + '\n\nTrack your order: ' + trackUrl(o) + '\n\nNatural Juices & Vitamins Ltd - 0207 205 2477 - naturaljuices.co.uk';
}

/** "New order" alert to the shop's alert address. */
async function orderAlert(o) {
  if (!enabled || !SHOP()) return false;
  const method = o.payment_method === 'paypal' ? 'PayPal' : 'Card';
  return send({
    to: SHOP(), replyTo: o.customer_email || undefined,
    subject: `New order ${o.order_no} — ${gbp(o.total_pence)} (${method})${o.livemode ? '' : ' [TEST]'}`,
    html: alertHtml(o), text: textFallback(o, 'New order ' + o.order_no + ' from ' + o.customer_name + ' (' + method + ')'),
  });
}
/** Alert to the shop + confirmation to the customer when an order is paid. */
async function orderPaid(o) {
  if (!enabled) return;
  await orderAlert(o);
  if (o.customer_email) {
    await send({
      to: o.customer_email, replyTo: SHOP() || undefined,
      subject: `Thanks for your order ${o.order_no} — Natural Juices`,
      html: confirmationHtml(o), text: textFallback(o, 'Hi ' + (o.customer_name || '').split(' ')[0] + ", we've received your order " + o.order_no + ' and are getting it ready.'),
    });
  }
}

/** "Your order is on its way" to the customer. */
async function orderDispatched(o) {
  if (!enabled || !o.customer_email) return false;
  return send({
    to: o.customer_email, replyTo: SHOP() || undefined,
    subject: `Your order ${o.order_no} is on its way — Natural Juices`,
    html: dispatchedHtml(o),
    text: textFallback(o, 'Good news - order ' + o.order_no + ' is on its way.' + (o.tracking_number ? ' Tracking: ' + (o.tracking_courier || '') + ' ' + o.tracking_number + (courierLink(o) ? ' ' + courierLink(o) : '') : '')),
  });
}

module.exports = { enabled, orderPaid, orderDispatched, orderAlert, alertAddress: SHOP, sent, setProducts: m => { products = m || {}; }, preview: { confirmationHtml, dispatchedHtml, alertHtml } };
