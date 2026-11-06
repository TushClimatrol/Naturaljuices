/**
 * NaturalJuices — order emails (optional)
 * ---------------------------------------
 * Sends: (1) "new order" alert to the shop, (2) order confirmation to the customer,
 * (3) "your order has been dispatched" to the customer.
 *
 * Switched on by setting these environment variables (e.g. the IONOS mailbox):
 *   SMTP_HOST   e.g. smtp.ionos.co.uk
 *   SMTP_PORT   587 (default) or 465
 *   SMTP_USER   the mailbox login, e.g. contact@naturaljuices.co.uk
 *   SMTP_PASS   the mailbox password
 *   MAIL_FROM   optional, defaults to "Natural Juices <SMTP_USER>"
 *   ORDER_ALERT_EMAIL  where new-order alerts go (defaults to SMTP_USER)
 * If SMTP_HOST is not set, nothing is sent and nothing breaks.
 */
const nodemailer = require('nodemailer');

const enabled = !!process.env.SMTP_HOST || process.env.MAIL_TEST === '1';
let transport = null;
const sent = []; // only filled in MAIL_TEST mode

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

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const gbp = p => '£' + (p / 100).toFixed(2);
const FROM = () => process.env.MAIL_FROM || ('Natural Juices <' + (process.env.SMTP_USER || 'contact@naturaljuices.co.uk') + '>');
const SHOP = () => process.env.ORDER_ALERT_EMAIL || process.env.SMTP_USER || '';

function itemsTable(o) {
  const rows = (o.items || []).map(i =>
    `<tr><td style="padding:6px 0">${i.qty} × ${esc(i.name)}${i.pack ? ' <span style="color:#667">(' + esc(i.pack) + ')</span>' : ''}</td>` +
    `<td style="padding:6px 0;text-align:right;white-space:nowrap">${gbp(i.line_pence)}</td></tr>`).join('');
  const disc = o.discount_pence > 0 ? `<tr><td>Discount${o.promo_code ? ' (' + esc(o.promo_code) + ')' : ''}</td><td style="text-align:right">−${gbp(o.discount_pence)}</td></tr>` : '';
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}${disc}` +
    `<tr><td style="padding:6px 0">Delivery</td><td style="text-align:right">FREE</td></tr>` +
    `<tr><td style="padding:10px 0 0;border-top:1px solid #dde;font-weight:bold">Total</td>` +
    `<td style="padding:10px 0 0;border-top:1px solid #dde;text-align:right;font-weight:bold">${gbp(o.total_pence)}</td></tr></table>`;
}
function addressBlock(o) {
  return [o.customer_name, o.address, o.city, o.postcode, o.country].filter(Boolean).map(esc).join('<br>');
}
function shell(title, inner) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1c2b22;line-height:1.5">
<h2 style="color:#1f6b3a;margin:0 0 12px">${esc(title)}</h2>${inner}
<p style="font-size:12px;color:#667;margin-top:28px;border-top:1px solid #dde;padding-top:12px">Natural Juices &amp; Vitamins Ltd · Braemar House, 30 Kings Avenue, Sunbury-on-Thames, TW16 7QE<br>
contact@naturaljuices.co.uk · 0207 205 2477 · naturaljuices.co.uk</p></div>`;
}

async function send(msg) {
  if (!enabled) return false;
  try {
    const info = await tx().sendMail(Object.assign({ from: FROM() }, msg));
    if (process.env.MAIL_TEST === '1') sent.push(JSON.parse(info.message));
    return true;
  } catch (e) { console.error('email failed (' + msg.subject + '):', e.message); return false; }
}

/** Alert to the shop + confirmation to the customer when an order is paid. */
async function orderPaid(o) {
  if (!enabled) return;
  const method = o.payment_method === 'paypal' ? 'PayPal' : 'Card';
  if (SHOP()) {
    await send({
      to: SHOP(), replyTo: o.customer_email || undefined,
      subject: `New order ${o.order_no} — ${gbp(o.total_pence)} (${method})${o.livemode ? '' : ' [TEST]'}`,
      html: shell('New order ' + o.order_no,
        `<p><b>${esc(o.customer_name)}</b> · ${esc(o.customer_email)} · ${esc(o.customer_phone)}</p>
         <p>${addressBlock(o)}</p>${o.customer_notes ? '<p><b>Customer note:</b> ' + esc(o.customer_notes) + '</p>' : ''}
         ${itemsTable(o)}
         <p>Paid by ${method}${o.payment_verified ? '' : ' — <b>payment not yet verified, please check in ' + method + '</b>'}. Ref: ${esc(o.payment_ref || '')}</p>`),
    });
  }
  if (o.customer_email) {
    await send({
      to: o.customer_email, replyTo: SHOP() || undefined,
      subject: `Your Natural Juices order ${o.order_no}`,
      html: shell('Thank you for your order',
        `<p>Hi ${esc((o.customer_name || '').split(' ')[0] || 'there')}, we've received your order <b>${esc(o.order_no)}</b> and are getting it ready.
         Orders placed before 2pm Monday–Friday are despatched the same day.</p>
         ${itemsTable(o)}
         <p style="margin-top:18px"><b>Delivering to</b><br>${addressBlock(o)}</p>
         <p>You can check your order at any time at <a href="https://naturaljuices.co.uk/#/track">naturaljuices.co.uk/#/track</a> using your order number and email address.</p>`),
    });
  }
}

/** "Your order is on its way" to the customer. */
async function orderDispatched(o) {
  if (!enabled || !o.customer_email) return false;
  const track = o.tracking_number
    ? `<p><b>Tracking:</b> ${esc(o.tracking_courier || 'Courier')} — ${esc(o.tracking_number)}</p>` : '';
  return send({
    to: o.customer_email, replyTo: SHOP() || undefined,
    subject: `Your Natural Juices order ${o.order_no} is on its way`,
    html: shell('Your order has been dispatched',
      `<p>Hi ${esc((o.customer_name || '').split(' ')[0] || 'there')}, good news — order <b>${esc(o.order_no)}</b> has left us and is on its way to you.</p>
       ${track}${itemsTable(o)}
       <p style="margin-top:18px"><b>Delivering to</b><br>${addressBlock(o)}</p>`),
  });
}

module.exports = { enabled, orderPaid, orderDispatched, sent };
