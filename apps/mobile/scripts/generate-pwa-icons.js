// Regenerates public/icons/*.png for the web manifest from this app's
// existing icon sources — run manually whenever those sources change
// (`node scripts/generate-pwa-icons.js` from apps/mobile).
//
// "any"-purpose icons are the flattened, full-bleed icon.png (the same
// source expo.icon/ios.icon already use, per docs/04-DESIGN-SYSTEM.md
// "App icon & splash") resized down — safe because nothing masks them.
//
// "maskable"-purpose icons are composed fresh from
// android-icon-foreground.png (the glyph-only cutout, already scaled to
// ~62% of its canvas per the same design-doc section so no adaptive-icon
// mask clips it) over a flat `#5F1B31` (color.brand.primary) background —
// reusing Android's own already-safe-zone-correct asset instead of
// guessing a new safe zone for icon.png's full gradient card.
const path = require('node:path');
const sharp = require('sharp');

const ASSETS = path.join(__dirname, '..', 'assets', 'images');
const OUT = path.join(__dirname, '..', 'public', 'icons');
const BRAND_PRIMARY = '#5F1B31';

async function main() {
  const iconSrc = path.join(ASSETS, 'icon.png');
  const fgSrc = path.join(ASSETS, 'android-icon-foreground.png');

  for (const size of [192, 512]) {
    await sharp(iconSrc)
      .resize(size, size)
      .png()
      .toFile(path.join(OUT, `icon-${size}.png`));
  }

  for (const size of [192, 512]) {
    const fg = await sharp(fgSrc).resize(size, size).toBuffer();
    await sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: BRAND_PRIMARY,
      },
    })
      .composite([{ input: fg }])
      .png()
      .toFile(path.join(OUT, `icon-maskable-${size}.png`));
  }

  // iOS ignores alpha on apple-touch-icon (renders transparent as black),
  // but icon.png is already fully opaque, so a direct resize is safe.
  await sharp(iconSrc).resize(180, 180).png().toFile(path.join(OUT, 'apple-touch-icon.png'));

  console.log(
    'Wrote icon-192.png, icon-512.png, icon-maskable-192.png, icon-maskable-512.png, apple-touch-icon.png to public/icons/',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
