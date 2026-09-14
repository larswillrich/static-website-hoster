# HostMyPage

**Drop a file. Get a link. Instantly.**

HostMyPage is a lightweight, self-hosted static website hosting service. Upload an HTML file or ZIP archive via drag-and-drop and receive an instant shareable link — no signup, no configuration, no hassle.

## Features

- **Instant hosting** — Upload and get a live URL in seconds
- **Drag-and-drop** — Drop an `.html` or `.zip` file onto the page
- **ZIP support** — Upload multi-file sites as a ZIP archive (must contain `index.html`)
- **Pay per upload** — 5.9 ct per upload, sold as 10 uploads for €0.59 via Stripe Checkout. No accounts: buyers get a credit code
- **Admin panel** — Manage and delete hosted sites
- **Reverse proxy ready** — Configurable `BASE_PATH` for deployment behind a reverse proxy
- **Docker-first** — Single-container deployment with multi-arch support (amd64 + arm64)
- **Lightweight** — Built on Node.js + Express with minimal dependencies

## Quick Start

### Docker (recommended)

```bash
docker run -d \
  -p 3000:3000 \
  -v hostmypage-data:/app/uploads \
  -v hostmypage-state:/app/data \
  -e STRIPE_SECRET_KEY=sk_live_... \
  -e STRIPE_WEBHOOK_SECRET=whsec_... \
  ghcr.io/<your-username>/static-website-hoster:latest
```

Then open [http://localhost:3000](http://localhost:3000).

> `/app/data` holds `payments.json` with every order and credit code. Without a volume there, all purchased credits are lost on the next deploy.

### From source

```bash
git clone https://github.com/<your-username>/static-website-hoster.git
cd static-website-hoster
npm install
npm start
```

The server starts on [http://localhost:3000](http://localhost:3000).

## Configuration

Configuration is done via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the server listens on |
| `BASE_PATH` | *(empty)* | URL path prefix for running behind a reverse proxy (e.g. `/staticwebsite`) |
| `STRIPE_SECRET_KEY` | *(empty)* | Stripe secret key (`sk_test_…` / `sk_live_…`). Without it, credits can't be bought and every upload is rejected |
| `STRIPE_WEBHOOK_SECRET` | *(empty)* | Signing secret of the Stripe webhook endpoint (`whsec_…`) |
| `PUBLIC_URL` | *(empty)* | Origin Stripe redirects back to, e.g. `http://localhost:3000`. Defaults to `https://[lang.]BASE_DOMAIN` of the current request |
| `ALLOWED_ORIGIN` | *(empty)* | Extra origin allowed to call `/upload` and `/api/checkout` (needed for local development, e.g. `http://localhost:3000`) |
| `SITES_HOST` | *(empty)* | Host that serves uploaded sites, e.g. `sites.host-my-page.com`. **Set this in production** (see [Uploaded sites on their own origin](#uploaded-sites-on-their-own-origin)). Without it, sites are served under `/sites/` on the main domain |
| `ADMIN_TOKEN` | *(empty)* | Token for the admin panel and admin APIs. Without it they are disabled |

### Reverse proxy example

If your app is served at `https://example.com/staticwebsite/`:

```bash
docker run -d \
  -p 3000:3000 \
  -e BASE_PATH=/staticwebsite \
  -v hostmypage-data:/app/uploads \
  ghcr.io/<your-username>/static-website-hoster:latest
```

The server respects `X-Forwarded-Proto` and `X-Forwarded-Host` headers so that generated URLs match the public address.

**Nginx example:**

```nginx
location /staticwebsite/ {
    proxy_pass http://127.0.0.1:3000/staticwebsite/;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    client_max_body_size 50M;
}
```

### Uploaded sites on their own origin

Uploaded sites contain arbitrary JavaScript. If they run on the same origin as the landing page, that JavaScript can read a visitor's credit code from `localStorage` and upload with it. `SITES_HOST` serves every uploaded site from a separate host instead:

- `https://sites.host-my-page.com/<slug>/` serves the site. That host serves nothing else: no landing page, no API, no uploads.
- Old links `https://host-my-page.com/sites/<slug>/` redirect there (301).
- Requests from the sites host to the main API are cross-origin and blocked by the browser.

Setup:

1. DNS: add an `A` record for `sites` pointing to the server (or a `CNAME` to the main domain).
2. Reverse proxy: route that host to the container. With Traefik, add a router:

   ```yaml
   - "traefik.http.routers.staticwebsite-sites.rule=Host(`sites.host-my-page.com`)"
   - traefik.http.routers.staticwebsite-sites.tls=true
   - traefik.http.routers.staticwebsite-sites.entrypoints=web,websecure
   - traefik.http.routers.staticwebsite-sites.tls.certresolver=mytlschallenge
   ```

3. Set `SITES_HOST=sites.host-my-page.com` and restart. Until it is set, the server logs a warning at startup.

## How It Works

1. A user drops an `.html` file or `.zip` archive onto the landing page
2. Without upload credits, the user buys 10 uploads for €0.59 in Stripe Checkout (see [Payments](#payments-stripe)). The dropped file is kept in the browser and published right after payment
3. The server generates a unique 8-character hex slug (e.g. `a3f1c8e2`)
4. For HTML files, the file is saved as `index.html` under the slug directory
5. For ZIP files, the archive is extracted; single-root-folder ZIPs are automatically flattened
6. After the content scan passes, one upload credit is used and the site is immediately available at `https://{SITES_HOST}/{slug}/` (without `SITES_HOST`: `{host}/sites/{slug}/`)

## Payments (Stripe)

Uploads cost 5.9 ct each and are sold as a pack of **10 uploads for €0.59**. Stripe's minimum charge is based on the account's settlement currency: CHF 0.50 for this account, and €0.50 converts to less than that. €0.59 leaves room for exchange rate changes. The price is defined only on the server (`CREDIT_PACK` in `server.js`); the client never sends an amount.

```
Browser ──POST /api/checkout──▶ Server: order "pending" in data/payments.json, Stripe Checkout Session
Browser ──redirect──▶ Stripe Checkout ──redirect──▶ /?checkout=success&session_id=…
Stripe ──signed webhook──▶ /api/stripe/webhook: checks signature, payment_status and amount → order "completed", credit code with 10 uploads
Browser ──GET /api/checkout/status/:sessionId (polling)──▶ credit code, stored in localStorage
Browser ──POST /upload + X-Credit-Code──▶ site published, one credit used
```

- **Only the webhook** marks an order as paid. The success redirect is not trusted.
- Credit codes are 16 characters (80 bits of randomness), shown as `ABCD-EFGH-JKLM-NPQR`. The code is shown prominently with a copy button after payment and after each upload, and in small print below the upload box. Users enter it under “Have a code?” to use their remaining uploads on another device or browser.
- The credit is checked before the upload is accepted and used atomically once the site is published. Rejected uploads don't use a credit.
- Orders live in `data/payments.json`. Mount `/app/data` as a volume.

### Setup

1. **API key:** copy the secret key from <https://dashboard.stripe.com/test/apikeys> into `STRIPE_SECRET_KEY`.
2. **Payment methods:** enable them under *Settings → Payment methods*. Card payments confirm instantly. Delayed methods such as SEPA Direct Debit only add credits once the payment succeeds (days later), so consider disabling them for this product.
3. **Webhook:** under *Developers → Webhooks → Add endpoint*, enter `https://<your-domain>{BASE_PATH}/api/stripe/webhook` and select these events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`

   Copy the signing secret into `STRIPE_WEBHOOK_SECRET` and restart. Test and live mode have separate endpoints and secrets.

### Local testing

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

```bash
STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... PUBLIC_URL=http://localhost:3000 ALLOWED_ORIGIN=http://localhost:3000 npm start
```

Use the `whsec_…` printed by `stripe listen`. Pay with `4242 4242 4242 4242` (any future date, any CVC); `4000 0025 0000 3155` tests 3-D Secure and `4000 0000 0000 9995` a declined card.

### Going live

- Live secret key and a **separate** live webhook with the four events above
- Business details, support email, terms and privacy URLs under *Settings → Public details*
- Selling to consumers in the EU: decide on VAT (`automatic_tax`) and invoices (`invoice_creation`), and collect consent to start the service before the withdrawal period ends (`consent_collection` + `custom_text`). The options are prepared as comments in `POST /api/checkout`
- Terms of service and privacy policy describe the paid service and Stripe as payment provider

## API

All endpoints are prefixed with `BASE_PATH` if configured.

### Upload a site

```
POST /upload
Content-Type: multipart/form-data
X-Credit-Code: ABCD-EFGH-JKLM-NPQR
Fields: site (file), csrf_token (from GET /api/csrf-token), recaptcha_token
```

Accepts `.html`, `.htm`, or `.zip` files up to **50 MB**. Without a credit code that has uploads left, the server answers `402 Payment Required`.

**Response (success):**
```json
{
  "success": true,
  "url": "https://sites.example.com/a3f1c8e2/",
  "slug": "a3f1c8e2",
  "remaining": 9
}
```

**Response (error):**
```json
{
  "success": false,
  "error": "Your ZIP must contain an index.html at the root level."
}
```

### Buy upload credits

```
POST /api/checkout
```

Creates a pending order and a Stripe Checkout Session for 10 uploads. No request body.

**Response:**
```json
{
  "url": "https://checkout.stripe.com/c/pay/cs_test_...",
  "sessionId": "cs_test_..."
}
```

### Payment status

```
GET /api/checkout/status/:sessionId
```

**Response:** `{ "paymentStatus": "pending" }`, `{ "paymentStatus": "failed" }` or, once the webhook has confirmed the payment:
```json
{
  "paymentStatus": "completed",
  "code": "ABCDEFGHJKLMNPQR",
  "remaining": 10
}
```

### Remaining credits

```
GET /api/credits
X-Credit-Code: ABCD-EFGH-JKLM-NPQR
```

**Response:** `{ "remaining": 7 }`, or `404` for an unknown code.

### Stripe webhook

```
POST /api/stripe/webhook
```

Called by Stripe only. Requests without a valid `Stripe-Signature` are rejected with `400`.

### List all sites

```
GET /api/sites
```

**Response:**
```json
{
  "sites": [
    {
      "slug": "a3f1c8e2",
      "url": "https://sites.example.com/a3f1c8e2/",
      "createdAt": "2025-03-01T12:00:00.000Z",
      "size": 15360
    }
  ]
}
```

### Delete a site

```
DELETE /api/sites/:slug
```

**Response:**
```json
{
  "success": true
}
```

### Access a hosted site

```
GET https://{SITES_HOST}/:slug/
```

Serves static files from the uploaded site with `index.html` as the default document. Without `SITES_HOST` the site is served at `GET /sites/:slug/`; with it, that path redirects to the sites host.

## Admin Panel

The admin panel is accessible at a hidden URL:

```
{BASE_PATH}/d7x9k2-panel
```

It provides an overview of all hosted sites with their URLs, upload timestamps, sizes, and a delete button for each site.

> **Note:** The admin panel and admin APIs require `ADMIN_TOKEN` (`?token=…` or `X-Admin-Token` header). Keep the link private.

## Project Structure

```
.
├── server.js              # Express server — routes, upload handling, API
├── public/
│   ├── index.html         # Landing page with drag-and-drop UI
│   ├── admin.html         # Admin panel
│   ├── favicon.svg        # Favicon
│   ├── og-image.svg       # Open Graph image source
│   └── og-image.png       # Open Graph image (generated at build time)
├── scripts/
│   └── generate-og.js     # SVG → PNG conversion for OG image
├── uploads/               # Hosted sites (gitignored, mount as volume)
├── data/                  # payments.json, analytics, abuse reports (gitignored, mount as volume)
├── Dockerfile             # Multi-stage Docker build
├── package.json
└── .github/
    └── workflows/
        └── docker-publish.yml  # CI/CD: build + push to GHCR
```

## Docker Build

Build the image locally:

```bash
docker build -t hostmypage .
```

The Dockerfile:
1. Uses `node:20-alpine` as the base image
2. Installs production dependencies with `npm ci`
3. Generates the Open Graph PNG from the SVG source at build time
4. Creates the required upload directories
5. Exposes port 3000

### Persistent storage

Mount `/app/uploads` (hosted sites) and `/app/data` (orders and credit codes) as volumes to persist them across container restarts:

```bash
docker run -d \
  -p 3000:3000 \
  -v /path/on/host/uploads:/app/uploads \
  -v /path/on/host/data:/app/data \
  hostmypage
```

## CI/CD

The GitHub Actions workflow (`.github/workflows/docker-publish.yml`) automatically builds and pushes a multi-architecture Docker image to **GitHub Container Registry (GHCR)** on every push to `main`.

- **Platforms:** `linux/amd64`, `linux/arm64`
- **Tags:** `latest` + commit SHA
- **Registry:** `ghcr.io`

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20 (Alpine) |
| Framework | Express 4 |
| File uploads | Multer |
| ZIP handling | ADM-ZIP |
| Image processing | Sharp (build-time OG image generation) |
| Frontend | Vanilla HTML/CSS/JS |
| Container | Docker (Alpine) |
| CI/CD | GitHub Actions |

## Upload Limits

- **Max file size:** 50 MB
- **Accepted formats:** `.html`, `.htm`, `.zip`
- **ZIP requirement:** Must contain an `index.html` at the root level (or inside a single root folder that gets auto-flattened)

## Security Considerations

- Slug validation prevents directory traversal (`/^[0-9a-f]{8}$/`)
- `X-Content-Type-Options: nosniff` header prevents MIME type sniffing
- Strict routing enabled to prevent redirect-based bypasses
- Temporary upload files are cleaned up after processing, on error and when an upload is rejected
- Uploaded sites run on their own origin (`SITES_HOST`), so their scripts can't read credit codes or call the API
- Uploads require a paid credit code, checked before the file is accepted and used atomically after publishing
- Credits are only issued by the signature-verified Stripe webhook
- Admin panel and admin APIs require `ADMIN_TOKEN`

## License

ISC
