const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, ''); // e.g. "/staticwebsite"
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// Redirect /staticwebsite -> /staticwebsite/ (trailing slash needed for relative URLs)
if (BASE_PATH) {
  app.get(BASE_PATH, (req, res) => {
    res.redirect(301, `${BASE_PATH}/`);
  });
}

// Serve the landing page under BASE_PATH
app.use(`${BASE_PATH}/`, express.static(path.join(__dirname, 'public')));

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

// Upload endpoint
app.post(`${BASE_PATH}/upload`, upload.single('site'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded.' });
  }

  const slug = generateSlug();
  const siteDir = path.join(UPLOADS_DIR, slug);
  const isHtml = req.file.originalname.endsWith('.html') || req.file.originalname.endsWith('.htm') || req.file.mimetype === 'text/html';

  try {
    fs.mkdirSync(siteDir, { recursive: true });

    if (isHtml) {
      // Single HTML file — save as index.html
      fs.renameSync(req.file.path, path.join(siteDir, 'index.html'));
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

    // Build the URL
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const url = `${protocol}://${host}${BASE_PATH}/sites/${slug}/`;

    res.json({ success: true, url, slug });
  } catch (err) {
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
