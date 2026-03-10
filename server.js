const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const app = express();
app.enable('strict routing');
const PORT = process.env.PORT || 3000;
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, ''); // e.g. "/staticwebsite"
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const RECAPTCHA_SECRET_KEY = process.env.RECAPTCHA_SECRET_KEY || '';

// --- i18n / Subdomain SEO configuration ---
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'host-my-page.com';
const SUPPORTED_LANGS = ['en', 'de', 'es', 'fr', 'ru', 'zh'];
const DEFAULT_LANG = 'en';

const LOCALE_MAP = {
  en: 'en_US', de: 'de_DE', es: 'es_ES', fr: 'fr_FR', ru: 'ru_RU', zh: 'zh_CN'
};

const SEO_META = {
  en: {
    title: 'HostMyPage — Free Static Website Hosting | Drag & Drop, No Signup',
    description: 'Host your static website for free in seconds. Drag & drop an HTML file or ZIP — get an instant shareable link. No signup, no Git, no CLI.'
  },
  de: {
    title: 'HostMyPage — Kostenloses Hosting für statische Websites | Drag & Drop, keine Anmeldung',
    description: 'Hoste deine statische Website kostenlos in Sekunden. HTML-Datei oder ZIP per Drag & Drop hochladen — sofort einen teilbaren Link erhalten. Ohne Anmeldung, ohne Git, ohne CLI.'
  },
  es: {
    title: 'HostMyPage — Alojamiento gratuito de sitios web estáticos | Arrastra y suelta, sin registro',
    description: 'Aloja tu sitio web estático gratis en segundos. Arrastra y suelta un archivo HTML o ZIP — obtén un enlace compartible al instante. Sin registro, sin Git, sin CLI.'
  },
  fr: {
    title: 'HostMyPage — Hébergement gratuit de sites web statiques | Glisser-déposer, sans inscription',
    description: 'Hébergez votre site web statique gratuitement en quelques secondes. Glissez-déposez un fichier HTML ou ZIP — obtenez un lien partageable instantanément. Sans inscription, sans Git, sans CLI.'
  },
  ru: {
    title: 'HostMyPage — Бесплатный хостинг статических сайтов | Перетащите файл, без регистрации',
    description: 'Размещайте статический сайт бесплатно за секунды. Перетащите HTML-файл или ZIP — получите мгновенную ссылку. Без регистрации, без Git, без CLI.'
  },
  zh: {
    title: 'HostMyPage — 免费静态网站托管 | 拖放上传，无需注册',
    description: '几秒内免费托管您的静态网站。拖放 HTML 文件或 ZIP — 即时获取可分享链接。无需注册，无需 Git，无需 CLI。'
  }
};

// Pages to include in sitemap (path relative to domain root)
const SITEMAP_PAGES = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/blog/', changefreq: 'weekly', priority: '0.8' },
  { path: '/blog/host-chatgpt-website', changefreq: 'monthly', priority: '0.7' },
  { path: '/blog/static-vs-dynamic-hosting', changefreq: 'monthly', priority: '0.7' },
  { path: '/blog/host-website-without-github', changefreq: 'monthly', priority: '0.7' },
];

// Cache index.html in memory
let indexHtmlTemplate = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf-8');
if (process.env.NODE_ENV !== 'production') {
  fs.watchFile(path.join(__dirname, 'public', 'index.html'), () => {
    try {
      indexHtmlTemplate = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf-8');
      console.log('index.html template reloaded');
    } catch {}
  });
}

// Helper: build subdomain URL for a language
function langUrl(lang, pagePath, protocol) {
  const prefix = lang === DEFAULT_LANG ? '' : `${lang}.`;
  return `${protocol}://${prefix}${BASE_DOMAIN}${BASE_PATH}${pagePath}`;
}

// Helper: strip language subdomain from host to get main domain host
function getMainDomainHost(req) {
  const host = req.headers['x-forwarded-host'] || req.get('host');
  // Remove lang prefix if present (e.g. "de.host-my-page.com" -> "host-my-page.com")
  for (const lang of SUPPORTED_LANGS) {
    if (lang !== DEFAULT_LANG && host.startsWith(`${lang}.`)) {
      return host.slice(lang.length + 1);
    }
  }
  return host;
}

// Recursive directory size calculation
function getDirectorySize(dirPath) {
  let totalSize = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      totalSize += getDirectorySize(fullPath);
    } else {
      totalSize += fs.statSync(fullPath).size;
    }
  }
  return totalSize;
}

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Security & SEO headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Subdomain language detection
app.use((req, res, next) => {
  const host = req.headers['x-forwarded-host'] || req.get('host') || '';
  const parts = host.split('.');
  // Check if first part is a supported language code (e.g. "de" in "de.host-my-page.com")
  if (parts.length > 2 && SUPPORTED_LANGS.includes(parts[0]) && parts[0] !== DEFAULT_LANG) {
    req.detectedLang = parts[0];
  } else {
    req.detectedLang = DEFAULT_LANG;
  }
  next();
});

// CORS: allow upload requests from main domain and all language subdomains
app.use(`${BASE_PATH}/upload`, (req, res, next) => {
  const origin = req.headers.origin;
  // Build set of allowed origins (main domain + all lang subdomains)
  const allowedOrigins = new Set();
  const customOrigin = process.env.ALLOWED_ORIGIN;
  if (customOrigin) allowedOrigins.add(customOrigin);
  for (const proto of ['https', 'http']) {
    allowedOrigins.add(`${proto}://${BASE_DOMAIN}`);
    for (const lang of SUPPORTED_LANGS) {
      if (lang !== DEFAULT_LANG) allowedOrigins.add(`${proto}://${lang}.${BASE_DOMAIN}`);
    }
  }
  const isAllowed = origin && allowedOrigins.has(origin);
  if (req.method === 'OPTIONS') {
    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    return res.sendStatus(204);
  }
  // Block cross-origin POST requests from unknown origins
  if (origin && !isAllowed) {
    return res.status(403).json({ success: false, error: 'Cross-origin requests not allowed.' });
  }
  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  next();
});

// CSRF token store (in-memory, tokens expire after 10 minutes)
const csrfTokens = new Map();
const CSRF_TOKEN_EXPIRY = 10 * 60 * 1000;

// Clean up expired CSRF tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, timestamp] of csrfTokens) {
    if (now - timestamp > CSRF_TOKEN_EXPIRY) csrfTokens.delete(token);
  }
}, 60 * 1000);

// Endpoint to get a CSRF token (must be fetched from the page before uploading)
app.get(`${BASE_PATH}/api/csrf-token`, (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  csrfTokens.set(token, Date.now());
  res.json({ token });
});

// Redirect /staticwebsite -> /staticwebsite/ (trailing slash needed for relative URLs)
if (BASE_PATH) {
  app.get(BASE_PATH, (req, res) => {
    res.redirect(301, `${BASE_PATH}/`);
  });
}

// Serve admin page under a cryptic path (security through obscurity)
app.get(`${BASE_PATH}/d7x9k2-panel`, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Blog redirect (trailing slash)
app.get(`${BASE_PATH}/blog`, (req, res) => {
  res.redirect(301, `${BASE_PATH}/blog/`);
});

// Dynamic robots.txt
app.get(`${BASE_PATH}/robots.txt`, (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const sitemapUrl = `${protocol}://${BASE_DOMAIN}${BASE_PATH}/sitemap.xml`;
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /d7x9k2-panel\nDisallow: /sites/\n\nSitemap: ${sitemapUrl}\n`
  );
});

// Dynamic sitemap.xml with hreflang alternates
app.get(`${BASE_PATH}/sitemap.xml`, (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n';
  xml += '        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n';
  for (const page of SITEMAP_PAGES) {
    for (const lang of SUPPORTED_LANGS) {
      const loc = langUrl(lang, page.path, protocol);
      xml += '  <url>\n';
      xml += `    <loc>${loc}</loc>\n`;
      xml += `    <changefreq>${page.changefreq}</changefreq>\n`;
      xml += `    <priority>${page.priority}</priority>\n`;
      // hreflang alternates for every language + x-default
      for (const altLang of SUPPORTED_LANGS) {
        xml += `    <xhtml:link rel="alternate" hreflang="${altLang}" href="${langUrl(altLang, page.path, protocol)}" />\n`;
      }
      xml += `    <xhtml:link rel="alternate" hreflang="x-default" href="${langUrl(DEFAULT_LANG, page.path, protocol)}" />\n`;
      xml += '  </url>\n';
    }
  }
  xml += '</urlset>\n';
  res.type('application/xml').send(xml);
});

// Dynamic index.html with server-side i18n for SEO
app.get(`${BASE_PATH}/`, (req, res) => {
  const lang = req.detectedLang;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const meta = SEO_META[lang] || SEO_META[DEFAULT_LANG];
  const locale = LOCALE_MAP[lang] || LOCALE_MAP[DEFAULT_LANG];
  const canonicalUrl = langUrl(lang, '/', protocol);

  let html = indexHtmlTemplate;

  // Set lang attribute
  html = html.replace('<html lang="en">', `<html lang="${lang}">`);

  // Replace title
  html = html.replace(
    /<title>[^<]*<\/title>/,
    `<title>${meta.title}</title>`
  );

  // Replace meta description
  html = html.replace(
    /<meta name="description" content="[^"]*">/,
    `<meta name="description" content="${meta.description}">`
  );

  // Replace canonical URL
  html = html.replace(
    /<link rel="canonical" href="[^"]*">/,
    `<link rel="canonical" href="${canonicalUrl}">`
  );

  // Replace og:url
  html = html.replace(
    /<meta property="og:url" content="[^"]*">/,
    `<meta property="og:url" content="${canonicalUrl}">`
  );

  // Replace og:locale
  html = html.replace(
    /<meta property="og:locale" content="[^"]*">/,
    `<meta property="og:locale" content="${locale}">`
  );

  // Replace og:title
  html = html.replace(
    /<meta property="og:title" content="[^"]*">/,
    `<meta property="og:title" content="${meta.title}">`
  );

  // Replace og:description
  html = html.replace(
    /<meta property="og:description" content="[^"]*">/,
    `<meta property="og:description" content="${meta.description}">`
  );

  // Build hreflang tags
  let hreflangTags = '';
  for (const altLang of SUPPORTED_LANGS) {
    hreflangTags += `  <link rel="alternate" hreflang="${altLang}" href="${langUrl(altLang, '/', protocol)}" />\n`;
  }
  hreflangTags += `  <link rel="alternate" hreflang="x-default" href="${langUrl(DEFAULT_LANG, '/', protocol)}" />\n`;
  // Inject after canonical
  html = html.replace(
    /(<link rel="canonical" href="[^"]*">)/,
    `$1\n${hreflangTags}`
  );

  // Replace language switcher buttons with anchor links
  for (const switchLang of SUPPORTED_LANGS) {
    const href = langUrl(switchLang, '/', protocol);
    const activeClass = switchLang === lang ? ' active' : '';
    // Replace <button> with <a>
    html = html.replace(
      new RegExp(`<button class="lang-btn[^"]*" data-lang="${switchLang}" title="([^"]*)" aria-label="([^"]*)"></button>`),
      `<a class="lang-btn${activeClass}" data-lang="${switchLang}" title="$1" aria-label="$2" href="${href}"></a>`
    );
  }

  // Inject server-side lang hint so client JS knows the detected language
  html = html.replace(
    "let currentLang = localStorage.getItem('lang') || 'en';",
    `let currentLang = '${lang}';`
  );

  res.setHeader('Vary', 'Host');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.type('html').send(html);
});

// Dynamic serving of legal/blog pages with hreflang injection
function serveWithHreflang(pagePath, filePath) {
  app.get(`${BASE_PATH}${pagePath}`, (req, res) => {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    let html;
    try {
      html = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return res.status(404).send('Not found');
    }
    // Inject hreflang tags before </head>
    let hreflangTags = '';
    for (const altLang of SUPPORTED_LANGS) {
      hreflangTags += `  <link rel="alternate" hreflang="${altLang}" href="${langUrl(altLang, pagePath, protocol)}" />\n`;
    }
    hreflangTags += `  <link rel="alternate" hreflang="x-default" href="${langUrl(DEFAULT_LANG, pagePath, protocol)}" />\n`;
    html = html.replace('</head>', `${hreflangTags}</head>`);
    res.setHeader('Vary', 'Host');
    res.type('html').send(html);
  });
}

serveWithHreflang('/imprint', path.join(__dirname, 'public', 'imprint.html'));
serveWithHreflang('/privacy', path.join(__dirname, 'public', 'privacy.html'));
serveWithHreflang('/terms', path.join(__dirname, 'public', 'terms.html'));
serveWithHreflang('/blog/', path.join(__dirname, 'public', 'blog', 'index.html'));

// Blog articles with hreflang
app.get(`${BASE_PATH}/blog/:slug`, (req, res, next) => {
  const slug = req.params.slug;
  if (!/^[a-z0-9-]+$/.test(slug)) return next();
  const filePath = path.join(__dirname, 'public', 'blog', `${slug}.html`);
  if (!fs.existsSync(filePath)) return next();
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  let html = fs.readFileSync(filePath, 'utf-8');
  let hreflangTags = '';
  for (const altLang of SUPPORTED_LANGS) {
    hreflangTags += `  <link rel="alternate" hreflang="${altLang}" href="${langUrl(altLang, `/blog/${slug}`, protocol)}" />\n`;
  }
  hreflangTags += `  <link rel="alternate" hreflang="x-default" href="${langUrl(DEFAULT_LANG, `/blog/${slug}`, protocol)}" />\n`;
  html = html.replace('</head>', `${hreflangTags}</head>`);
  res.setHeader('Vary', 'Host');
  res.type('html').send(html);
});

// Serve the landing page under BASE_PATH with caching
app.use(`${BASE_PATH}/`, express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    // Cache static assets longer
    if (filePath.endsWith('.png') || filePath.endsWith('.svg')) {
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day
    }
    // Proper content type for sitemap
    if (filePath.endsWith('sitemap.xml')) {
      res.setHeader('Content-Type', 'application/xml');
    }
  }
}));

// Configure multer for file uploads
const upload = multer({
  dest: '/tmp/uploads',
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const isZip = file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || file.originalname.endsWith('.zip');
    const isHtml = file.mimetype === 'text/html' || file.originalname.endsWith('.html') || file.originalname.endsWith('.htm');
    if (isZip || isHtml) {
      cb(null, true);
    } else {
      cb(new Error('Only HTML and ZIP files are allowed'));
    }
  }
});

// Generate a unique slug
function generateSlug() {
  let slug;
  let attempts = 0;
  do {
    slug = crypto.randomBytes(4).toString('hex');
    attempts++;
  } while (fs.existsSync(path.join(UPLOADS_DIR, slug)) && attempts < 10);
  return slug;
}

// Health check (shows if reCAPTCHA is configured, without exposing the key)
app.get(`${BASE_PATH}/api/health`, (req, res) => {
  res.json({
    status: 'ok',
    recaptchaConfigured: !!RECAPTCHA_SECRET_KEY,
    recaptchaKeyLength: RECAPTCHA_SECRET_KEY.length,
    envKeys: Object.keys(process.env).filter(k => k.includes('RECAPTCHA')).join(', ') || 'none'
  });
});

// API: List all hosted sites
app.get(`${BASE_PATH}/api/sites`, (req, res) => {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) {
      return res.json({ sites: [] });
    }

    const entries = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true });
    const sites = entries
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const dirPath = path.join(UPLOADS_DIR, entry.name);
        const stats = fs.statSync(dirPath);
        const size = getDirectorySize(dirPath);
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = getMainDomainHost(req);
        const url = `${protocol}://${host}${BASE_PATH}/sites/${entry.name}/`;
        return {
          slug: entry.name,
          url,
          createdAt: stats.birthtime.toISOString(),
          size
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ sites });
  } catch (err) {
    console.error('Error listing sites:', err);
    res.status(500).json({ error: 'Failed to list sites.' });
  }
});

// API: Delete a hosted site
app.delete(`${BASE_PATH}/api/sites/:slug`, (req, res) => {
  const slug = req.params.slug;

  if (!/^[0-9a-f]{8}$/.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug format.' });
  }

  const siteDir = path.join(UPLOADS_DIR, slug);

  if (!fs.existsSync(siteDir)) {
    return res.status(404).json({ error: 'Site not found.' });
  }

  try {
    fs.rmSync(siteDir, { recursive: true, force: true });
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting site:', err);
    res.status(500).json({ error: 'Failed to delete site.' });
  }
});

// Rate limiting for uploads: 5 requests per 15 minutes per IP
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip,
  handler: (req, res) => {
    res.status(429).json({ success: false, error: 'Too many uploads. Please try again later.' });
  }
});

// Verify reCAPTCHA v3 token with Google
async function verifyRecaptcha(token) {
  if (!RECAPTCHA_SECRET_KEY) return { success: true, score: 1.0 }; // Skip if no key configured
  try {
    const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${encodeURIComponent(RECAPTCHA_SECRET_KEY)}&response=${encodeURIComponent(token)}`
    });
    return await response.json();
  } catch (err) {
    console.error('reCAPTCHA verification error:', err);
    return { success: false, score: 0 };
  }
}

// Upload endpoint
app.post(`${BASE_PATH}/upload`, uploadLimiter, upload.single('site'), async (req, res) => {
  // CSRF token verification
  const csrfToken = req.body && req.body.csrf_token;
  if (!csrfToken || !csrfTokens.has(csrfToken)) {
    return res.status(403).json({ success: false, error: 'Invalid or missing security token. Please reload and try again.' });
  }
  csrfTokens.delete(csrfToken); // Single-use token

  // Honeypot check: bots fill hidden fields, real users don't
  if (req.body && req.body.website) {
    return res.status(400).json({ success: false, error: 'Failed to process uploaded file.' });
  }

  // reCAPTCHA v3 verification
  const recaptchaToken = req.body && req.body.recaptcha_token;
  if (RECAPTCHA_SECRET_KEY && !recaptchaToken) {
    return res.status(400).json({ success: false, error: 'Security verification missing. Please reload and try again.' });
  }
  if (RECAPTCHA_SECRET_KEY) {
    const captchaResult = await verifyRecaptcha(recaptchaToken);
    if (!captchaResult.success || captchaResult.score < 0.5) {
      console.log(`reCAPTCHA rejected: success=${captchaResult.success}, score=${captchaResult.score}`);
      return res.status(403).json({ success: false, error: 'Security verification failed. Please try again.' });
    }
  }

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded.' });
  }

  const slug = generateSlug();
  const siteDir = path.join(UPLOADS_DIR, slug);
  const isHtml = req.file.originalname.endsWith('.html') || req.file.originalname.endsWith('.htm') || req.file.mimetype === 'text/html';

  try {
    fs.mkdirSync(siteDir, { recursive: true });

    if (isHtml) {
      // Single HTML file — save as index.html (copyFile + unlink to support cross-device moves)
      fs.copyFileSync(req.file.path, path.join(siteDir, 'index.html'));
      fs.unlinkSync(req.file.path);
    } else {
      // ZIP file — extract
      const zip = new AdmZip(req.file.path);
      zip.extractAllTo(siteDir, true);

      // Flatten single-root-folder ZIPs
      const entries = fs.readdirSync(siteDir);
      if (entries.length === 1) {
        const singleEntry = path.join(siteDir, entries[0]);
        if (fs.statSync(singleEntry).isDirectory()) {
          const innerFiles = fs.readdirSync(singleEntry);
          for (const f of innerFiles) {
            fs.renameSync(path.join(singleEntry, f), path.join(siteDir, f));
          }
          fs.rmdirSync(singleEntry);
        }
      }

      // Verify index.html exists in ZIP
      if (!fs.existsSync(path.join(siteDir, 'index.html'))) {
        fs.rmSync(siteDir, { recursive: true, force: true });
        return res.status(400).json({
          success: false,
          error: 'Your ZIP must contain an index.html at the root level.'
        });
      }

      // Clean up temp file
      fs.unlinkSync(req.file.path);
    }

    // Build the URL (always use main domain, not language subdomains)
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = getMainDomainHost(req);
    const url = `${protocol}://${host}${BASE_PATH}/sites/${slug}/`;

    res.json({ success: true, url, slug });
  } catch (err) {
    console.error('Upload error:', err);
    // Clean up on failure
    if (fs.existsSync(siteDir)) {
      fs.rmSync(siteDir, { recursive: true, force: true });
    }
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(400).json({ success: false, error: 'Failed to process uploaded file.' });
  }
});

// Serve hosted static sites
app.use(`${BASE_PATH}/sites`, express.static(UPLOADS_DIR, {
  extensions: ['html'],
  index: ['index.html']
}));

// Multer error handling
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, error: 'File too large. Maximum size is 50 MB.' });
    }
    return res.status(400).json({ success: false, error: err.message });
  }
  if (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  next();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Static Website Hoster running on http://localhost:${PORT}${BASE_PATH}/`);
});
