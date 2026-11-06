# NaturalJuices shop server

The behind-the-scenes server for https://naturaljuices.co.uk (hosted on Render as the **Naturaljuices** web service).

| What | Where |
|---|---|
| Card payments (Stripe Checkout) | `POST /create-checkout-session` |
| Order book (every card + PayPal order) | PostgreSQL database (`DATABASE_URL`) |
| **Staff order dashboard** | `https://naturaljuices.onrender.com/admin` |
| Customer order tracking | shop page `/#/track` → `POST /orders/track` |
| Health check | `GET /health` |

## Settings (Render → Naturaljuices → Environment)

| Name | Needed? | What it is |
|---|---|---|
| `STRIPE_SECRET_KEY` | yes (already set) | Stripe key. `…_test_…` = test mode, `…_live_…` = real cards |
| `DATABASE_URL` | **yes** | PostgreSQL connection string. Without it orders are **not saved** |
| `ADMIN_PASSWORD` | **yes** | Password for `/admin`. Pick a long one |
| `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET` | recommended | Lets the server confirm each PayPal payment with PayPal. Without them PayPal orders show “Check PayPal” |
| `STRIPE_WEBHOOK_SECRET` | recommended | Signing secret of a Stripe webhook pointing at `/webhook/stripe` (event `checkout.session.completed`, `charge.refunded`) — catches card orders even if the customer closes the tab |
| `PAYPAL_WEBHOOK_ID` | optional | Id of a PayPal webhook pointing at `/webhook/paypal` (`PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `ORDER_ALERT_EMAIL` | optional | Turns on emails: new-order alert, customer confirmation, dispatch email |
| `SESSION_SECRET` | optional | Random text used to sign the dashboard login cookie |

## When products or prices change on the site

The server charges the prices in `catalog.json`, **not** whatever the browser says. After editing products in the
site's `index.html`, rebuild it and commit:

    node scripts/sync-catalog.js ../naturaljuices-site/index.html

## Tests

    TEST_DATABASE_URL=postgres://user:pass@localhost/throwaway npm test

Runs the real server against a throwaway database with fake Stripe/PayPal (52 checks: pricing, payment confirmation,
duplicate protection, sign-in security, dashboard, CSV export, tracking).
