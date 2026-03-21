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
const ANALYTICS_DIR = path.join(__dirname, 'data', 'analytics');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_EXTRACTED_SIZE = 200 * 1024 * 1024; // 200 MB max extracted ZIP size
const MAX_ZIP_FILES = 500; // Max files in a ZIP archive
const SITE_MAX_AGE_DAYS = parseInt(process.env.SITE_MAX_AGE_DAYS) || 30; // Auto-expiry
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // Required for admin panel access
const REPORTS_DIR = path.join(__dirname, 'data', 'reports');
const RECAPTCHA_SECRET_KEY = process.env.RECAPTCHA_SECRET_KEY || '';

// --- Analytics logging (DSGVO-compliant, no cookies, hashed IPs) ---
for (const dir of [ANALYTICS_DIR, REPORTS_DIR, path.join(__dirname, 'data')]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Daily rotating salt for IP hashing (not stored, regenerated daily)
let _analyticsSalt = crypto.randomBytes(32).toString('hex');
let _analyticsSaltDay = new Date().toISOString().slice(0, 10);

function getAnalyticsSalt() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _analyticsSaltDay) {
    _analyticsSalt = crypto.randomBytes(32).toString('hex');
    _analyticsSaltDay = today;
  }
  return _analyticsSalt;
}

function hashIP(ip) {
  return crypto.createHash('sha256').update(ip + getAnalyticsSalt()).digest('hex').slice(0, 16);
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || 'unknown';
}

function logAnalyticsEvent(type, data) {
  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(ANALYTICS_DIR, `${today}.json`);
  const entry = { type, timestamp: new Date().toISOString(), ...data };
  try {
    let entries = [];
    if (fs.existsSync(logFile)) {
      entries = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
    }
    entries.push(entry);
    fs.writeFileSync(logFile, JSON.stringify(entries));
  } catch (err) {
    console.error('Analytics log error:', err.message);
  }
}

function loadAnalyticsData(days = 30) {
  const results = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const logFile = path.join(ANALYTICS_DIR, `${dateStr}.json`);
    try {
      if (fs.existsSync(logFile)) {
        const entries = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
        results.push(...entries);
      }
    } catch {}
  }
  return results;
}

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
  // CSP for the main landing page (not user-hosted sites)
  if (!req.path.startsWith(`${BASE_PATH}/sites/`)) {
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.google.com https://www.gstatic.com https://www.googletagmanager.com https://cdn.jsdelivr.net; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.googletagmanager.com; " +
      "frame-src https://www.google.com; connect-src 'self' https://www.google-analytics.com https://www.googletagmanager.com; font-src 'self';"
    );
  }
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

// Admin authentication middleware
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).send('Admin panel disabled. Set ADMIN_TOKEN env variable.');
  }
  const token = req.query.token || req.headers['x-admin-token'];
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).send('Unauthorized. Provide ?token=YOUR_ADMIN_TOKEN');
  }
  next();
}

// Serve admin page (requires ADMIN_TOKEN)
app.get(`${BASE_PATH}/d7x9k2-panel`, requireAdmin, (req, res) => {
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

  // Track landing page visit for conversion rate
  logAnalyticsEvent('landing', {
    ipHash: hashIP(getClientIP(req)),
    referrer: req.headers['referer'] || req.headers['referrer'] || ''
  });

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
serveWithHreflang('/disclaimer', path.join(__dirname, 'public', 'disclaimer.html'));
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

// --- Magic byte validation ---
const MAGIC_BYTES = {
  zip: [0x50, 0x4B, 0x03, 0x04],
};

function validateMagicBytes(filePath, expectedType) {
  if (expectedType !== 'zip') return true; // HTML is text, no magic bytes
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    const expected = MAGIC_BYTES.zip;
    return expected.every((byte, i) => buf[i] === byte);
  } catch {
    return false;
  }
}

// --- Safe ZIP extraction (Zip Slip + symlink + bomb protection) ---
function safeExtractZip(zipPath, destDir) {
  const zip = new AdmZip(zipPath);
  const zipEntries = zip.getEntries();
  const resolvedDest = fs.realpathSync(destDir);

  // ZIP bomb check: total file count
  if (zipEntries.length > MAX_ZIP_FILES) {
    return { error: `ZIP contains too many files (${zipEntries.length}, max ${MAX_ZIP_FILES}).` };
  }

  // ZIP bomb check: total uncompressed size
  let totalSize = 0;
  for (const entry of zipEntries) {
    totalSize += entry.header.size;
    if (totalSize > MAX_EXTRACTED_SIZE) {
      return { error: `ZIP extracted size exceeds ${MAX_EXTRACTED_SIZE / 1024 / 1024} MB limit.` };
    }
  }

  for (const entry of zipEntries) {
    const entryPath = path.join(destDir, entry.entryName);
    const resolvedEntry = path.resolve(entryPath);

    // Zip Slip: ensure resolved path is within destination
    if (!resolvedEntry.startsWith(resolvedDest + path.sep) && resolvedEntry !== resolvedDest) {
      return { error: 'ZIP contains path traversal entries.' };
    }

    // Symlink protection
    if (entry.header.attr && (entry.header.attr & 0xA0000000) !== 0) {
      return { error: 'ZIP contains symbolic links.' };
    }

    if (entry.isDirectory) {
      fs.mkdirSync(resolvedEntry, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(resolvedEntry), { recursive: true });
      fs.writeFileSync(resolvedEntry, entry.getData());
    }
  }

  return { error: null };
}

// --- Auto-expiry: clean up sites older than SITE_MAX_AGE_DAYS ---
function cleanExpiredSites() {
  if (!fs.existsSync(UPLOADS_DIR)) return;
  const now = Date.now();
  const maxAge = SITE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  try {
    const entries = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(UPLOADS_DIR, entry.name);
      try {
        const stats = fs.statSync(dirPath);
        if (now - stats.birthtimeMs > maxAge) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          console.log(`Auto-expired site: ${entry.name}`);
        }
      } catch {}
    }
  } catch (err) {
    console.error('Auto-expiry error:', err.message);
  }
}

// Run cleanup on startup and every 6 hours
cleanExpiredSites();
setInterval(cleanExpiredSites, 6 * 60 * 60 * 1000);

// --- Dangerous file extension blocklist ---
const BLOCKED_EXTENSIONS = new Set([
  '.php', '.php3', '.php4', '.php5', '.phtml',
  '.asp', '.aspx', '.jsp', '.jspx',
  '.cgi', '.pl', '.py', '.rb', '.sh', '.bash',
  '.exe', '.bat', '.cmd', '.com', '.msi', '.dll', '.scr', '.pif',
  '.jar', '.war', '.class',
  '.htaccess', '.htpasswd',
]);

function checkBlockedExtensions(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const result = checkBlockedExtensions(fullPath);
      if (result) return result;
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (BLOCKED_EXTENSIONS.has(ext)) {
        return `Blocked file type: ${ext} (${entry.name})`;
      }
    }
  }
  return null;
}

// --- Upload content scanner (detect phishing, credential harvesting, etc.) ---
const SUSPICIOUS_PATTERNS = [
  // Obfuscated code
  { pattern: /document\.write\s*\(\s*unescape\s*\(/i, reason: 'Obfuscated code (document.write + unescape)' },
  { pattern: /document\.write\s*\(\s*atob\s*\(/i, reason: 'Obfuscated code (document.write + atob)' },
  { pattern: /eval\s*\(\s*atob\s*\(/i, reason: 'Obfuscated code (eval + atob)' },
  { pattern: /eval\s*\(\s*unescape\s*\(/i, reason: 'Obfuscated code (eval + unescape)' },
  { pattern: /eval\s*\(\s*String\.fromCharCode/i, reason: 'Obfuscated code (eval + fromCharCode)' },
  // Hidden iframes
  { pattern: /<iframe[^>]+style\s*=\s*"[^"]*position\s*:\s*fixed[^"]*width\s*:\s*100%/i, reason: 'Hidden fullscreen iframe overlay' },
  { pattern: /<iframe[^>]+style\s*=\s*"[^"]*visibility\s*:\s*hidden/i, reason: 'Hidden iframe' },
  // Credential harvesting
  { pattern: /<form[^>]+action\s*=\s*"https?:\/\/[^"]+\.(php|asp|aspx|jsp)/i, reason: 'Form posting credentials to external server' },
  { pattern: /type\s*=\s*"password".*action\s*=\s*"https?:\/\//is, reason: 'Password field with external form action' },
  { pattern: /\.php\??(email|user|pass|login|credential)/i, reason: 'Suspected credential exfiltration endpoint' },
  // External script loading (phishing kits, skimmers)
  { pattern: /<script[^>]+src\s*=\s*"https?:\/\/[^"]*\.(tk|ml|ga|cf|gq|buzz|top|work|click|surf)\//i, reason: 'Script loaded from suspicious TLD' },
  // Crypto miners
  { pattern: /coinhive\.min\.js|CoinHive\.Anonymous|coin-hive/i, reason: 'Crypto miner (CoinHive)' },
  { pattern: /webminerpool|minero\.cc|cryptoloot|crypto-loot/i, reason: 'Crypto miner detected' },
  { pattern: /miner\.start\s*\(|startMining\s*\(/i, reason: 'Crypto mining API call' },
  // Redirects to external sites
  { pattern: /<meta[^>]+http-equiv\s*=\s*"refresh"[^>]+url\s*=\s*https?:\/\//i, reason: 'Meta refresh redirect to external URL' },
  { pattern: /window\.location\s*[=.]\s*["']https?:\/\//i, reason: 'JavaScript redirect to external URL' },
  { pattern: /location\s*\.\s*replace\s*\(\s*["']https?:\/\//i, reason: 'JavaScript redirect to external URL' },
  { pattern: /location\s*\.\s*href\s*=\s*["']https?:\/\//i, reason: 'JavaScript redirect to external URL' },
  // Base64 payload hiding (large blobs > 5KB suggest obfuscation)
  { pattern: /atob\s*\(\s*["'][A-Za-z0-9+/=]{5000,}["']\s*\)/i, reason: 'Large Base64-encoded payload (possible obfuscation)' },
  { pattern: /data:text\/html;base64,[A-Za-z0-9+/=]{1000,}/i, reason: 'Base64-encoded HTML data URI' },
];

// Content hash tracking for previously flagged uploads
const FLAGGED_HASHES_FILE = path.join(__dirname, 'data', 'flagged-hashes.json');

function loadFlaggedHashes() {
  try {
    if (fs.existsSync(FLAGGED_HASHES_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(FLAGGED_HASHES_FILE, 'utf-8')));
    }
  } catch {}
  return new Set();
}

function saveFlaggedHash(hash) {
  const hashes = loadFlaggedHashes();
  hashes.add(hash);
  fs.writeFileSync(FLAGGED_HASHES_FILE, JSON.stringify([...hashes]));
}

function hashDirectoryContent(dirPath) {
  const hash = crypto.createHash('sha256');
  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      hash.update(hashDirectoryContent(fullPath));
    } else {
      hash.update(entry.name);
      hash.update(fs.readFileSync(fullPath));
    }
  }
  return hash.digest('hex');
}

function scanFileContent(content) {
  for (const { pattern, reason } of SUSPICIOUS_PATTERNS) {
    if (pattern.test(content)) {
      return reason;
    }
  }
  return null;
}

function scanDirectory(dirPath) {
  // Check blocked file extensions first
  const blockedResult = checkBlockedExtensions(dirPath);
  if (blockedResult) return blockedResult;

  // Check content hash against previously flagged uploads
  const contentHash = hashDirectoryContent(dirPath);
  const flaggedHashes = loadFlaggedHashes();
  if (flaggedHashes.has(contentHash)) {
    return 'Content matches a previously flagged upload';
  }

  // Scan file contents
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      // Skip blocked extensions check (already done above) — only scan content
      const result = scanDirectoryContent(fullPath);
      if (result) return result;
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.html', '.htm', '.js'].includes(ext)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const result = scanFileContent(content);
          if (result) {
            // Save hash so re-uploads of same content are instantly blocked
            saveFlaggedHash(contentHash);
            return `${result} (in ${entry.name})`;
          }
        } catch {}
      }
    }
  }
  return null;
}

// Content-only scan for subdirectories (extension check already done at top level)
function scanDirectoryContent(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const result = scanDirectoryContent(fullPath);
      if (result) return result;
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.html', '.htm', '.js'].includes(ext)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const result = scanFileContent(content);
          if (result) return `${result} (in ${entry.name})`;
        } catch {}
      }
    }
  }
  return null;
}

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

// API: List all hosted sites (admin only)
app.get(`${BASE_PATH}/api/sites`, requireAdmin, (req, res) => {
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

// API: Delete a hosted site (admin only)
app.delete(`${BASE_PATH}/api/sites/:slug`, requireAdmin, (req, res) => {
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
      // Validate magic bytes (ensure it's actually a ZIP)
      if (!validateMagicBytes(req.file.path, 'zip')) {
        fs.rmSync(siteDir, { recursive: true, force: true });
        try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(400).json({
          success: false,
          error: 'Invalid ZIP file.'
        });
      }

      // Safe ZIP extraction (Zip Slip, symlink, and bomb protection)
      const extractResult = safeExtractZip(req.file.path, siteDir);
      if (extractResult.error) {
        fs.rmSync(siteDir, { recursive: true, force: true });
        try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(400).json({
          success: false,
          error: extractResult.error
        });
      }

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

    // Scan uploaded content for suspicious patterns
    const scanResult = scanDirectory(siteDir);
    if (scanResult) {
      console.warn(`Upload rejected (slug ${slug}): ${scanResult}`);
      fs.rmSync(siteDir, { recursive: true, force: true });
      return res.status(400).json({
        success: false,
        error: 'Upload rejected: suspicious content detected. If you believe this is a mistake, please contact support.'
      });
    }

    // Build the URL (always use main domain, not language subdomains)
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = getMainDomainHost(req);
    const url = `${protocol}://${host}${BASE_PATH}/sites/${slug}/`;

    // Log upload event (DSGVO-compliant)
    logAnalyticsEvent('upload', {
      ipHash: hashIP(getClientIP(req)),
      userAgent: req.headers['user-agent'] || '',
      fileSize: req.file.size,
      fileType: isHtml ? 'html' : 'zip',
      referrer: req.headers['referer'] || req.headers['referrer'] || '',
      slug
    });

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

// Serve hosted static sites with analytics tracking and sandbox headers
app.use(`${BASE_PATH}/sites`, (req, res, next) => {
  // Sandbox user-hosted content: restrict capabilities to prevent cross-origin attacks
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none';");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  // Only log initial page loads (not assets like .css, .js, .png etc.)
  const ext = path.extname(req.path).toLowerCase();
  if (!ext || ext === '.html' || ext === '.htm') {
    const slugMatch = req.path.match(/^\/([0-9a-f]{8})/);
    if (slugMatch) {
      logAnalyticsEvent('pageview', {
        ipHash: hashIP(getClientIP(req)),
        slug: slugMatch[1],
        referrer: req.headers['referer'] || req.headers['referrer'] || ''
      });
    }
  }
  next();
}, express.static(UPLOADS_DIR, {
  extensions: ['html'],
  index: ['index.html']
}));

// API: Report abuse for a hosted site (public, rate-limited)
const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip,
});

app.use(`${BASE_PATH}/api/report`, express.json());
app.post(`${BASE_PATH}/api/report`, reportLimiter, (req, res) => {
  const { slug, reason } = req.body || {};
  if (!slug || !/^[0-9a-f]{8}$/.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug.' });
  }
  if (!reason || typeof reason !== 'string' || reason.length > 500) {
    return res.status(400).json({ error: 'Reason is required (max 500 chars).' });
  }
  const report = {
    slug,
    reason: reason.slice(0, 500),
    timestamp: new Date().toISOString(),
    ipHash: hashIP(getClientIP(req)),
  };
  const reportFile = path.join(REPORTS_DIR, `${new Date().toISOString().slice(0, 10)}.json`);
  try {
    let reports = [];
    if (fs.existsSync(reportFile)) {
      reports = JSON.parse(fs.readFileSync(reportFile, 'utf-8'));
    }
    reports.push(report);
    fs.writeFileSync(reportFile, JSON.stringify(reports));
  } catch (err) {
    console.error('Report save error:', err.message);
  }
  res.json({ success: true, message: 'Report received. We will review it shortly.' });
});

// API: Analytics data (admin only, aggregated, DSGVO-compliant)
app.get(`${BASE_PATH}/api/analytics`, requireAdmin, (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const events = loadAnalyticsData(days);

  const uploads = events.filter(e => e.type === 'upload');
  const pageviews = events.filter(e => e.type === 'pageview');

  // --- Uploads per day ---
  const uploadsPerDay = {};
  uploads.forEach(e => {
    const day = e.timestamp.slice(0, 10);
    uploadsPerDay[day] = (uploadsPerDay[day] || 0) + 1;
  });

  // --- Uploads per week ---
  const uploadsPerWeek = {};
  uploads.forEach(e => {
    const d = new Date(e.timestamp);
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - d.getDay() + 1); // Monday
    const weekKey = weekStart.toISOString().slice(0, 10);
    uploadsPerWeek[weekKey] = (uploadsPerWeek[weekKey] || 0) + 1;
  });

  // --- Unique uploaders (distinct IP hashes) ---
  const uniqueUploaders = new Set(uploads.map(e => e.ipHash)).size;

  // --- Returning uploaders (IP hashes with >1 upload) ---
  const uploaderCounts = {};
  uploads.forEach(e => {
    uploaderCounts[e.ipHash] = (uploaderCounts[e.ipHash] || 0) + 1;
  });
  const returningUploaders = Object.values(uploaderCounts).filter(c => c > 1).length;

  // --- Pageviews per slug ---
  const viewsPerSlug = {};
  pageviews.forEach(e => {
    viewsPerSlug[e.slug] = (viewsPerSlug[e.slug] || 0) + 1;
  });

  // --- Pageviews per day ---
  const pageviewsPerDay = {};
  pageviews.forEach(e => {
    const day = e.timestamp.slice(0, 10);
    pageviewsPerDay[day] = (pageviewsPerDay[day] || 0) + 1;
  });

  // --- Unique visitors (pageviews) ---
  const uniqueVisitors = new Set(pageviews.map(e => e.ipHash)).size;

  // --- Popular hours (upload times) ---
  const uploadsByHour = Array(24).fill(0);
  uploads.forEach(e => {
    const hour = new Date(e.timestamp).getHours();
    uploadsByHour[hour]++;
  });

  // --- File types distribution ---
  const fileTypes = { html: 0, zip: 0 };
  uploads.forEach(e => {
    if (e.fileType === 'html') fileTypes.html++;
    else fileTypes.zip++;
  });

  // --- Average file size ---
  const avgFileSize = uploads.length > 0
    ? Math.round(uploads.reduce((sum, e) => sum + (e.fileSize || 0), 0) / uploads.length)
    : 0;

  // --- Top referrers (uploads) ---
  const uploadReferrers = {};
  uploads.forEach(e => {
    if (e.referrer) {
      try {
        const host = new URL(e.referrer).hostname;
        uploadReferrers[host] = (uploadReferrers[host] || 0) + 1;
      } catch {}
    }
  });

  // --- Top referrers (pageviews) ---
  const viewReferrers = {};
  pageviews.forEach(e => {
    if (e.referrer) {
      try {
        const host = new URL(e.referrer).hostname;
        viewReferrers[host] = (viewReferrers[host] || 0) + 1;
      } catch {}
    }
  });

  // --- Homepage visits (approximate: count events for today from landing) ---
  const totalLandingPageViews = events.filter(e => e.type === 'landing').length;

  // --- Conversion rate (uploads / unique landing page visitors) ---
  const landingVisitors = new Set(events.filter(e => e.type === 'landing').map(e => e.ipHash)).size;
  const conversionRate = landingVisitors > 0
    ? (uniqueUploaders / landingVisitors * 100).toFixed(1)
    : null;

  // --- Top viewed sites ---
  const topSites = Object.entries(viewsPerSlug)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([slug, views]) => ({ slug, views }));

  res.json({
    period: { days, from: new Date(Date.now() - days * 86400000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
    totals: {
      uploads: uploads.length,
      pageviews: pageviews.length,
      uniqueUploaders,
      returningUploaders,
      uniqueVisitors,
      avgFileSize,
      conversionRate
    },
    fileTypes,
    uploadsPerDay,
    uploadsPerWeek,
    pageviewsPerDay,
    uploadsByHour,
    topSites,
    uploadReferrers,
    viewReferrers
  });
});

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
