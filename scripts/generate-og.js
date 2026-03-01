#!/usr/bin/env node
// Generates og-image.png from og-image.svg at build time
const sharp = require('sharp');
const path = require('path');

const svgPath = path.join(__dirname, '..', 'public', 'og-image.svg');
const pngPath = path.join(__dirname, '..', 'public', 'og-image.png');

sharp(svgPath)
  .resize(1200, 630)
  .png({ quality: 90 })
  .toFile(pngPath)
  .then(() => console.log('Generated og-image.png'))
  .catch(err => { console.error('Failed to generate OG image:', err); process.exit(1); });
