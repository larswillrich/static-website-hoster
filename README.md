# HostMyPage

**Drop a file. Get a link. Instantly.**

HostMyPage is a lightweight, self-hosted static website hosting service. Upload an HTML file or ZIP archive via drag-and-drop and receive an instant shareable link — no signup, no configuration, no hassle.

## Features

- **Instant hosting** — Upload and get a live URL in seconds
- **Drag-and-drop** — Drop an `.html` or `.zip` file onto the page
- **ZIP support** — Upload multi-file sites as a ZIP archive (must contain `index.html`)
- **Zero signup** — No accounts, no authentication for uploaders
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
  ghcr.io/<your-username>/static-website-hoster:latest
```

Then open [http://localhost:3000](http://localhost:3000).

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

## How It Works

1. A user drops an `.html` file or `.zip` archive onto the landing page
2. The server generates a unique 8-character hex slug (e.g. `a3f1c8e2`)
3. For HTML files, the file is saved as `index.html` under the slug directory
4. For ZIP files, the archive is extracted; single-root-folder ZIPs are automatically flattened
5. The site is immediately available at `{host}/sites/{slug}/`

## API

All endpoints are prefixed with `BASE_PATH` if configured.

### Upload a site

```
POST /upload
Content-Type: multipart/form-data
Field: site (file)
```

Accepts `.html`, `.htm`, or `.zip` files up to **50 MB**.

**Response (success):**
```json
{
  "success": true,
  "url": "https://example.com/sites/a3f1c8e2/",
  "slug": "a3f1c8e2"
}
```

**Response (error):**
```json
{
  "success": false,
  "error": "Your ZIP must contain an index.html at the root level."
}
```

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
      "url": "https://example.com/sites/a3f1c8e2/",
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
GET /sites/:slug/
```

Serves static files from the uploaded site with `index.html` as the default document.

## Admin Panel

The admin panel is accessible at a hidden URL:

```
{BASE_PATH}/d7x9k2-panel
```

It provides an overview of all hosted sites with their URLs, upload timestamps, sizes, and a delete button for each site.

> **Note:** The admin panel has no authentication and relies on the obscurity of the URL. For production use, consider restricting access at the reverse proxy level.

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

Mount `/app/uploads` as a volume to persist hosted sites across container restarts:

```bash
docker run -d \
  -p 3000:3000 \
  -v /path/on/host:/app/uploads \
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
- Temporary upload files are cleaned up after processing or on error
- Admin panel is not authenticated — restrict access via reverse proxy in production

## License

ISC
