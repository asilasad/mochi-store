/* ============================================================
   Mochi Kiss Balm — store server (Express)
   ------------------------------------------------------------
   Serves the website and the Stripe Checkout endpoint.
   Runs on any Node host (Railway, Render, Fly, etc.).

   Requires ONE environment variable on the host:
     STRIPE_SECRET_KEY   (Stripe Dashboard -> Developers -> API keys)
   The host provides PORT automatically.

   Prices live HERE, on the server — the browser only sends
   product IDs + quantities, never prices.
   ============================================================ */

const express = require('express');
const path = require('path');
const Stripe = require('stripe');

const app = express();
app.use(express.json());

/* The single source of truth for prices. Amounts in CENTS (USD). */
const CATALOG = {
  strawberry: { name: 'Strawberry Mochi — Mochi Kiss Balm', price: 1500 },
  mango:      { name: 'Mango Mochi — Mochi Kiss Balm',      price: 1500 },
  taro:       { name: 'Taro Mochi — Mochi Kiss Balm',       price: 1500 },
  peach:      { name: 'Peach Mochi — Mochi Kiss Balm',      price: 1500 },
  box:        { name: 'The Mochi Box — all 4 shades',       price: 4800 }
};
const FREE_SHIP_CENTS = 3500; // free shipping at $35+
const SHIP_FEE_CENTS  = 400;  // $4 flat below that
const WELCOME_COUPON  = 'N4gqi492'; // 10% welcome coupon (promo code SQUISH10)
const SUB_DISCOUNT    = 0.15; // subscribe & save — 15% off
const SUB_INTERVAL    = { interval: 'week', interval_count: 8 }; // refill every 8 weeks

/* ============================================================
   Order-confirmation email — sent via Resend (https://resend.com).
   Needs this environment variable on the host:
     RESEND_API_KEY  = your Resend API key (starts with "re_")
   Optional: MAIL_FROM (default: Mochi <hellosquishy@mochilipstick.com>)
   The "from" domain must be verified in Resend first.
   ============================================================ */
const emailedSessions = new Set();

function orderConfirmationEmail(order, baseUrl) {
  const ref = 'MOCHI-' + String(order.id || '').slice(-8).toUpperCase();
  const m = function (c) { return '$' + ((c || 0) / 100).toFixed(2); };
  const rows = (order.items || []).map(function (i) {
    return '<tr><td style="padding:7px 0;font-size:15px;color:#43303A;">' + i.name + ' &times;' + i.qty +
      '</td><td style="padding:7px 0;font-size:15px;color:#43303A;text-align:right;font-weight:bold;">' + m(i.amount) + '</td></tr>';
  }).join('');
  const firstName = order.name ? (' ' + String(order.name).split(' ')[0]) : '';
  const html =
'<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FCF7F0;">' +
'<table width="100%" cellpadding="0" cellspacing="0" style="background:#FCF7F0;padding:24px 0;"><tr><td align="center">' +
'<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:22px;overflow:hidden;">' +
'<tr><td><img src="' + baseUrl + '/images/email-header.jpg" width="520" alt="Mochi" style="display:block;width:100%;height:auto;border:0;"></td></tr>' +
'<tr><td style="padding:30px 34px;font-family:Arial,Helvetica,sans-serif;">' +
'<h1 style="margin:0 0 8px;font-size:25px;color:#E0455A;">your kiss is on its way</h1>' +
'<p style="margin:0 0 18px;font-size:15px;color:#7C6670;line-height:1.6;">hi' + firstName + ', thank you for choosing mochi. your order is confirmed and your lips are about to be very happy.</p>' +
'<table width="100%" cellpadding="0" cellspacing="0" style="background:#FBEEF1;border-radius:14px;"><tr><td style="padding:18px 20px;">' +
'<p style="margin:0 0 10px;font-size:12px;letter-spacing:1px;color:#E0455A;font-weight:bold;">ORDER #' + ref + '</p>' +
'<table width="100%" cellpadding="0" cellspacing="0">' + rows +
'<tr><td style="padding:8px 0 4px;border-top:1px dashed #E9C4CC;font-size:14px;color:#7C6670;">subtotal</td><td style="padding:8px 0 4px;border-top:1px dashed #E9C4CC;font-size:14px;color:#7C6670;text-align:right;">' + m(order.amountSubtotal) + '</td></tr>' +
'<tr><td style="padding:4px 0;font-size:14px;color:#7C6670;">shipping</td><td style="padding:4px 0;font-size:14px;color:#7C6670;text-align:right;">' + (order.amountShipping ? m(order.amountShipping) : 'free') + '</td></tr>' +
'<tr><td style="padding:10px 0 0;border-top:2px solid #43303A;font-size:17px;color:#E0455A;font-weight:bold;">total paid</td><td style="padding:10px 0 0;border-top:2px solid #43303A;font-size:17px;color:#E0455A;font-weight:bold;text-align:right;">' + m(order.amountTotal) + '</td></tr>' +
'</table></td></tr></table>' +
'<p style="margin:20px 0 0;font-size:14px;color:#7C6670;line-height:1.6;">we will send tracking as soon as it ships, usually within 1-2 business days.</p>' +
'<table cellpadding="0" cellspacing="0" style="margin:22px 0 4px;"><tr><td style="border-radius:999px;background:#E0455A;"><a href="' + baseUrl + '" style="display:inline-block;padding:13px 32px;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">shop more mochi</a></td></tr></table>' +
'</td></tr>' +
'<tr><td style="padding:22px 34px;background:#FCF7F0;font-family:Arial,sans-serif;text-align:center;">' +
'<p style="margin:0 0 4px;font-size:18px;color:#E0455A;font-weight:bold;">mochi</p>' +
'<p style="margin:0;font-size:12px;color:#7C6670;line-height:1.7;">the tinted lip balm that loves your lips back<br>questions? just reply to this email &middot; hellosquishy@mochilipstick.com</p>' +
'</td></tr></table></td></tr></table></body></html>';
  return { subject: 'your mochi order is confirmed (' + ref + ')', html: html };
}

function sendConfirmationEmail(order, baseUrl) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !order || !order.email) return;
  if (emailedSessions.has(order.id)) return;
  emailedSessions.add(order.id);
  const msg = orderConfirmationEmail(order, baseUrl);
  fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || 'Mochi <hellosquishy@mochilipstick.com>',
      to: [order.email],
      subject: msg.subject,
      html: msg.html
    })
  }).then(function (r) {
    if (r.ok) {
      console.log('confirmation email sent to ' + order.email);
    } else {
      emailedSessions.delete(order.id);
      r.text().then(function (t) { console.error('resend error:', t); });
    }
  }).catch(function (e) {
    emailedSessions.delete(order.id);
    console.error('confirmation email failed:', e && e.message);
  });
}

/* ---- Stripe checkout endpoint ---- */
/* ---- welcome email (newsletter signup, includes the 10% code) ---- */
const subscribedEmails = new Set();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function welcomeEmail(baseUrl) {
  const html =
'<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FCF7F0;">' +
'<table width="100%" cellpadding="0" cellspacing="0" style="background:#FCF7F0;padding:24px 0;"><tr><td align="center">' +
'<table width="540" cellpadding="0" cellspacing="0" style="max-width:540px;width:100%;background:#ffffff;border-radius:22px;overflow:hidden;">' +
'<tr><td><img src="' + baseUrl + '/images/email-welcome.jpg" width="540" alt="Mochi" style="display:block;width:100%;height:auto;border:0;"></td></tr>' +
'<tr><td style="padding:32px 36px;font-family:Arial,Helvetica,sans-serif;">' +
'<h1 style="margin:0 0 8px;font-size:27px;color:#E0455A;">welcome to the squish</h1>' +
'<p style="margin:0 0 16px;font-size:15px;color:#7C6670;line-height:1.65;">hi there, and welcome to mochi &mdash; we are so happy you are here.</p>' +
'<p style="margin:0 0 16px;font-size:15px;color:#43303A;line-height:1.65;">we make one thing, and we make it the best in the world: a tinted lip balm that is genuinely good <i>for</i> your lips.</p>' +
'<p style="margin:0 0 16px;font-size:15px;color:#7C6670;line-height:1.65;">most lip products make you choose &mdash; pretty colour that dries you out, or real care that is basically clear. and if your lips are sensitive, every cute viral product seems to sting or flake. we thought that was a problem worth solving.</p>' +
'<p style="margin:0 0 22px;font-size:15px;color:#7C6670;line-height:1.65;">so we built <b style="color:#43303A;">Mochi Kiss Balm</b> the other way around: barrier-repairing skincare first &mdash; ceramides, hyaluronic acid, fragrance-free, dermatologist-tested &mdash; then tinted into four buttery, buildable shades. colour and comfort, no compromise. a little hug for your lips.</p>' +
'<table width="100%" cellpadding="0" cellspacing="0" style="background:#FBEEF1;border-radius:16px;"><tr><td style="padding:22px 24px;text-align:center;">' +
'<p style="margin:0 0 6px;font-size:12px;letter-spacing:1.5px;color:#7C6670;font-weight:bold;">YOUR WELCOME GIFT</p>' +
'<p style="margin:0 0 10px;font-size:22px;color:#E0455A;font-weight:bold;">10% off your first kiss</p>' +
'<p style="margin:0 0 6px;font-size:13px;color:#7C6670;">enter this code at checkout</p>' +
'<p style="margin:0;font-size:25px;letter-spacing:3px;color:#43303A;font-weight:bold;font-family:Courier New,monospace;">SQUISH10</p>' +
'</td></tr></table>' +
'<table cellpadding="0" cellspacing="0" style="margin:24px auto 6px;"><tr><td style="border-radius:999px;background:#E0455A;">' +
'<a href="' + baseUrl + '/?promo=SQUISH10" style="display:inline-block;padding:14px 36px;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">shop the shades — 10% applied</a>' +
'</td></tr></table>' +
'<p style="margin:18px 0 0;font-size:14px;color:#7C6670;line-height:1.6;text-align:center;font-style:italic;">soft on lips. serious about them.</p>' +
'</td></tr>' +
'<tr><td style="padding:22px 36px;background:#FCF7F0;font-family:Arial,sans-serif;text-align:center;">' +
'<p style="margin:0 0 4px;font-size:18px;color:#E0455A;font-weight:bold;">mochi</p>' +
'<p style="margin:0;font-size:12px;color:#7C6670;line-height:1.7;">the tinted lip balm that loves your lips back<br>questions? just reply to this email &middot; hellosquishy@mochilipstick.com</p>' +
'</td></tr></table></td></tr></table></body></html>';
  return { subject: 'welcome to mochi — here is 10% off your first kiss', html: html };
}

function sendWelcomeEmail(email, baseUrl) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) return;
  if (subscribedEmails.has(e)) return;
  subscribedEmails.add(e);
  const msg = welcomeEmail(baseUrl);
  fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || 'Mochi <hellosquishy@mochilipstick.com>',
      to: [e],
      subject: msg.subject,
      html: msg.html
    })
  }).then(function (r) {
    if (r.ok) {
      console.log('welcome email sent to ' + e);
    } else {
      subscribedEmails.delete(e);
      r.text().then(function (t) { console.error('welcome email error:', t); });
    }
  }).catch(function (err) {
    subscribedEmails.delete(e);
    console.error('welcome email failed:', err && err.message);
  });
}

app.post('/api/create-checkout', async (req, res) => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY is not set on the host yet.' });
  }
  try {
    const stripe = Stripe(key);
    const cart = Array.isArray(req.body && req.body.cart) ? req.body.cart : [];
    if (!cart.length) return res.status(400).json({ error: 'Your bag is empty.' });

    let subtotal = 0;
    let hasSub = false;
    const line_items = [];
    for (const item of cart) {
      const product = CATALOG[item && item.id];
      if (!product) continue;
      let qty = parseInt(item && item.qty, 10) || 1;
      qty = Math.max(1, Math.min(qty, 20));
      const isSub = !!(item && item.mode === 'sub');
      if (isSub) hasSub = true;
      const unit = isSub ? Math.round(product.price * (1 - SUB_DISCOUNT)) : product.price;
      subtotal += unit * qty;
      const price_data = {
        currency: 'usd',
        unit_amount: unit,
        product_data: { name: product.name + (isSub ? ' — refill subscription' : '') }
      };
      if (isSub) price_data.recurring = SUB_INTERVAL; // real recurring price: billed every 8 weeks
      line_items.push({ quantity: qty, price_data });
    }
    if (!line_items.length) return res.status(400).json({ error: 'No valid items in cart.' });

    const host = req.headers.origin ||
      ((req.headers['x-forwarded-proto'] || 'https') + '://' + req.headers.host);
    const base = (host || '').split('#')[0].replace(/\/$/, '') || 'https://example.com';
    const shipFee = subtotal >= FREE_SHIP_CENTS ? 0 : SHIP_FEE_CENTS;

    const sessionParams = {
      mode: hasSub ? 'subscription' : 'payment',
      line_items,
      billing_address_collection: 'auto',
      shipping_address_collection: { allowed_countries: ['US', 'CA', 'GB', 'AU'] },
      shipping_options: [{
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: shipFee, currency: 'usd' },
          display_name: shipFee === 0 ? 'Free shipping' : 'Standard shipping',
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 2 },
            maximum: { unit: 'business_day', value: 5 }
          }
        }
      }],
      success_url: base + '/?checkout=success&session_id={CHECKOUT_SESSION_ID}#/confirmed',
      cancel_url:  base + '/#/cart'
    };
    if (hasSub) {
      // Subscription checkout: let the customer type a code; the welcome
      // coupon is a one-time first-order offer and isn't auto-stacked here.
      sessionParams.allow_promotion_codes = true;
    } else if (req.body && req.body.promo) {
      sessionParams.discounts = [{ coupon: WELCOME_COUPON }]; // welcome 10% auto-applied via the email link
    } else {
      sessionParams.allow_promotion_codes = true;             // otherwise the customer can type a code
    }
    const session = await stripe.checkout.sessions.create(sessionParams);

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: (err && err.message) || 'Checkout failed.' });
  }
});

/* ---- order lookup (for the confirmation page + receipt) ---- */
app.get('/api/order', async (req, res) => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(500).json({ error: 'Stripe not configured' });
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).json({ error: 'Missing session_id' });
  try {
    const stripe = Stripe(key);
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items', 'payment_intent.latest_charge', 'invoice']
    });
    const items = ((session.line_items && session.line_items.data) || []).map(li => ({
      name: li.description, qty: li.quantity, amount: li.amount_total
    }));
    let receiptUrl = null;
    const pi = session.payment_intent;
    if (pi && pi.latest_charge && pi.latest_charge.receipt_url) receiptUrl = pi.latest_charge.receipt_url;
    else if (session.invoice && session.invoice.hosted_invoice_url) receiptUrl = session.invoice.hosted_invoice_url;
    const order = {
      id: session.id,
      paid: session.payment_status === 'paid',
      email: (session.customer_details && session.customer_details.email) || '',
      name: (session.customer_details && session.customer_details.name) || '',
      currency: (session.currency || 'usd').toUpperCase(),
      amountTotal: session.amount_total || 0,
      amountSubtotal: session.amount_subtotal || 0,
      amountShipping: (session.total_details && session.total_details.amount_shipping) || 0,
      items: items,
      receiptUrl: receiptUrl,
      created: session.created || Math.floor(Date.now() / 1000)
    };
    if (order.paid) {
      const base = (req.headers.origin || ('https://' + req.headers.host)).replace(/\/$/, '');
      sendConfirmationEmail(order, base);
    }
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: (err && err.message) || 'Could not load order' });
  }
});

/* ---- newsletter signup -> welcome email with the 10% code ---- */
app.post('/api/subscribe', (req, res) => {
  const email = req.body && req.body.email;
  if (!email || !EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ error: 'Please enter a valid email.' });
  }
  const base = (req.headers.origin || ('https://' + req.headers.host)).replace(/\/$/, '');
  sendWelcomeEmail(email, base);
  res.json({ ok: true });
});

/* ---- serve the website ---- */
app.use(express.static(__dirname));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Mochi store running on port ' + PORT));
