import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = "/Users/louiscarter/carterco";
const src = "/Users/louiscarter/Downloads/ad images/IMG_2533.JPG";
const outDir = path.join(root, "clients/carterco/assets/fb-ads");
const width = 1080;
const height = 1350;
const crop = { left: 210, top: 0, width: 1325, height: 1656 };

const text = ["Har I B2B-leads?", "Lad mig finde én proces", "AI kan forbedre på 20 min."];

const variants = [
  {
    name: "sharp-01-clean-left",
    layout: "top",
    family: "Avenir Next, Helvetica Neue, Arial, sans-serif",
    sizes: [82, 62, 62],
    weights: [800, 500, 500],
    x: 82,
    y: 108,
    line: 1.16,
    color: "#fffaf0",
    brand: "bottom",
  },
  {
    name: "sharp-02-human-note",
    layout: "note",
    family: "Avenir Next, Helvetica Neue, Arial, sans-serif",
    sizes: [74, 58, 58],
    weights: [800, 500, 500],
    x: 76,
    y: 104,
    line: 1.18,
    color: "#fffaf0",
    brand: "bottom",
  },
  {
    name: "sharp-03-soft-card",
    layout: "card",
    family: "Avenir Next, Helvetica Neue, Arial, sans-serif",
    sizes: [62, 50, 50],
    weights: [800, 500, 500],
    x: 66,
    y: 82,
    line: 1.2,
    color: "#27221c",
    brand: "bottom-dark",
  },
  {
    name: "sharp-04-bottom-bold",
    layout: "bottom",
    family: "Avenir Next, Helvetica Neue, Arial, sans-serif",
    sizes: [76, 58, 58],
    weights: [800, 500, 500],
    x: 76,
    y: 1010,
    line: 1.14,
    color: "#fffaf0",
    brand: "top",
  },
  {
    name: "sharp-05-ai-pill",
    layout: "pill",
    family: "Avenir Next, Helvetica Neue, Arial, sans-serif",
    sizes: [76, 58, 58],
    weights: [800, 500, 500],
    x: 74,
    y: 104,
    line: 1.16,
    color: "#fffaf0",
    brand: "bottom",
  },
  {
    name: "sharp-06-editorial",
    layout: "top",
    family: "Georgia, serif",
    sizes: [72, 56, 56],
    weights: [700, 400, 400],
    x: 76,
    y: 102,
    line: 1.18,
    color: "#fff7e6",
    brand: "bottom",
  },
];

function esc(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function gradient(layout) {
  if (layout === "bottom") {
    return `<rect width="1080" height="1350" fill="url(#bottomFade)"/>`;
  }
  return `<rect width="1080" height="1350" fill="url(#topFade)"/>`;
}

function textSvg(v) {
  const defs = `
    <defs>
      <linearGradient id="topFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(0,0,0,0.66)"/>
        <stop offset="42%" stop-color="rgba(0,0,0,0.20)"/>
        <stop offset="72%" stop-color="rgba(0,0,0,0)"/>
      </linearGradient>
      <linearGradient id="bottomFade" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="rgba(0,0,0,0.72)"/>
        <stop offset="42%" stop-color="rgba(0,0,0,0.22)"/>
        <stop offset="72%" stop-color="rgba(0,0,0,0)"/>
      </linearGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
        <feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#000" flood-opacity="0.42"/>
      </filter>
    </defs>`;

  const lineEls = [];
  let y = v.y;
  for (let i = 0; i < text.length; i++) {
    const size = v.sizes[i];
    lineEls.push(`<text x="${v.x}" y="${y}" font-size="${size}" font-weight="${v.weights[i]}" fill="${v.color}" font-family="${v.family}" letter-spacing="-0.4" filter="${v.layout === "card" ? "" : "url(#shadow)"}">${esc(text[i])}</text>`);
    y += Math.round(size * v.line);
  }

  const brandFill = v.brand === "bottom-dark" ? "rgba(39,34,28,0.72)" : "rgba(255,250,240,0.78)";
  const brandY = v.brand === "top" ? 90 : 1252;
  const brandX = v.brand === "top" ? 76 : 82;

  const card = v.layout === "card"
    ? `<rect x="52" y="60" width="790" height="302" rx="34" fill="rgba(255,250,240,0.90)"/>`
    : "";
  const noteLine = v.layout === "note"
    ? `<path d="M76 ${v.y + 88} C230 ${v.y + 76}, 420 ${v.y + 94}, 760 ${v.y + 84}" stroke="rgba(255,229,166,0.72)" stroke-width="8" stroke-linecap="round" fill="none"/>`
    : "";
  const pill = v.layout === "pill"
    ? `<rect x="72" y="${v.y + 132}" width="688" height="72" rx="22" fill="rgba(196,92,42,0.86)"/>`
    : "";

  return Buffer.from(`
    <svg width="1080" height="1350" viewBox="0 0 1080 1350" xmlns="http://www.w3.org/2000/svg">
      ${defs}
      ${gradient(v.layout)}
      ${card}
      ${noteLine}
      ${pill}
      <g>${lineEls.join("\n")}</g>
      <text x="${brandX}" y="${brandY}" font-size="31" font-weight="500" fill="${brandFill}" font-family="Avenir Next, Helvetica Neue, Arial, sans-serif">Carter &amp; Co</text>
    </svg>
  `);
}

async function make(v) {
  const base = await sharp(src)
    .extract(crop)
    .resize(width, height, { fit: "cover" })
    .modulate({ saturation: 0.94 })
    .linear(1.04, -5)
    .toBuffer();

  const png = path.join(outDir, `carterco-fb-ad-img2533-${v.name}.png`);
  const jpg = path.join(outDir, `carterco-fb-ad-img2533-${v.name}.jpg`);

  const composed = sharp(base).composite([{ input: textSvg(v), top: 0, left: 0 }]);
  await composed.png({ compressionLevel: 9 }).toFile(png);
  await sharp(await composed.toBuffer()).jpeg({ quality: 92, mozjpeg: true }).toFile(jpg);
  console.log(jpg);
}

await fs.mkdir(outDir, { recursive: true });
for (const v of variants) {
  await make(v);
}
