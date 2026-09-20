#!/usr/bin/env node
// Generates the social preview image and the square app icons at build time.
//
// The <text> elements in og-image.svg need a real font on the system. node:20-alpine ships
// without any, which silently renders every line of text as nothing — a link preview that is
// an empty dark rectangle. The Dockerfile therefore installs font-liberation, which fontconfig
// substitutes for the Helvetica/Arial and monospace families the SVG asks for.
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'public');
const ogSvg = path.join(publicDir, 'og-image.svg');
const faviconSvg = path.join(publicDir, 'favicon.svg');

// Wraps a PNG in an ICO container (one image). Every browser that still asks for /favicon.ico
// reads PNG-in-ICO, and sharp has no ICO encoder of its own.
function pngToIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size < 256 ? size : 0, 0); // width (0 means 256)
  entry.writeUInt8(size < 256 ? size : 0, 1); // height
  entry.writeUInt8(0, 2); // palette colours
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12); // offset of the PNG data
  return Buffer.concat([header, entry, png]);
}

async function main() {
  await sharp(ogSvg)
    .resize(1200, 630)
    .png({ quality: 90 })
    .toFile(path.join(publicDir, 'og-image.png'));
  console.log('Generated og-image.png');

  // Square icons for home screens, bookmarks and browser tabs
  for (const size of [180, 32]) {
    const name = size === 180 ? 'apple-touch-icon.png' : `favicon-${size}.png`;
    await sharp(faviconSvg).resize(size, size).png().toFile(path.join(publicDir, name));
    console.log(`Generated ${name}`);
  }

  const ico = await sharp(faviconSvg).resize(32, 32).png().toBuffer();
  fs.writeFileSync(path.join(publicDir, 'favicon.ico'), pngToIco(ico, 32));
  console.log('Generated favicon.ico');
}

main().catch(err => {
  console.error('Failed to generate images:', err);
  process.exit(1);
});
