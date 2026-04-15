#!/usr/bin/env node
// Generate 1280x860 presentation-style screenshot templates.
// Usage:
//   node scripts/make-screenshot-template.mjs <title> <subtitle> <output.png>
//
// Example:
//   node scripts/make-screenshot-template.mjs "Status Tab" "Real-time invoice feed" docs/screenshots/status-tab.png
//
// The output is a clean slide with a gradient background, title, subtitle,
// and a centered placeholder area (800x500) where you paste your actual
// screenshot. Use any image editor to composite the real UI on top.

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
let canvas = null;
try {
  canvas = require("canvas").createCanvas;
} catch {
  // not installed — SVG fallback
}

const W = 1280;
const H = 860;
const title = process.argv[2] || "KSeF InvoSync";
const subtitle = process.argv[3] || "Screenshot placeholder";
const output = process.argv[4] || "docs/screenshots/template.png";

if (!canvas) {
  // Fallback: generate SVG template
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a1a2e"/>
      <stop offset="100%" stop-color="#16213e"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <text x="640" y="80" text-anchor="middle" fill="#e2e8f0" font-family="system-ui, sans-serif" font-size="36" font-weight="700">${title}</text>
  <text x="640" y="120" text-anchor="middle" fill="#94a3b8" font-family="system-ui, sans-serif" font-size="18">${subtitle}</text>
  <rect x="240" y="160" width="800" height="540" rx="12" fill="#0f172a" stroke="#334155" stroke-width="2"/>
  <text x="640" y="440" text-anchor="middle" fill="#475569" font-family="system-ui, sans-serif" font-size="24">Paste screenshot here (800×540)</text>
  <text x="640" y="790" text-anchor="middle" fill="#475569" font-family="system-ui, sans-serif" font-size="14">KSeF InvoSync — GPL-3.0 — k0ss11</text>
</svg>`;

  const svgOutput = output.replace(/\.png$/, ".svg");
  writeFileSync(svgOutput, svg);
  console.log(`Created SVG template: ${svgOutput}`);
  console.log("Install 'canvas' npm package for PNG output: npm install canvas");
  process.exit(0);
}

// PNG generation with canvas
const c = canvas(W, H);
const ctx = c.getContext("2d");

// Gradient background
const grad = ctx.createLinearGradient(0, 0, W, H);
grad.addColorStop(0, "#1a1a2e");
grad.addColorStop(1, "#16213e");
ctx.fillStyle = grad;
ctx.fillRect(0, 0, W, H);

// Title
ctx.fillStyle = "#e2e8f0";
ctx.font = "bold 36px system-ui, sans-serif";
ctx.textAlign = "center";
ctx.fillText(title, W / 2, 80);

// Subtitle
ctx.fillStyle = "#94a3b8";
ctx.font = "18px system-ui, sans-serif";
ctx.fillText(subtitle, W / 2, 120);

// Screenshot placeholder
ctx.fillStyle = "#0f172a";
ctx.strokeStyle = "#334155";
ctx.lineWidth = 2;
const px = 240, py = 160, pw = 800, ph = 540, pr = 12;
ctx.beginPath();
ctx.roundRect(px, py, pw, ph, pr);
ctx.fill();
ctx.stroke();

// Placeholder text
ctx.fillStyle = "#475569";
ctx.font = "24px system-ui, sans-serif";
ctx.fillText("Paste screenshot here (800×540)", W / 2, py + ph / 2);

// Footer
ctx.fillStyle = "#475569";
ctx.font = "14px system-ui, sans-serif";
ctx.fillText("KSeF InvoSync — GPL-3.0 — k0ss11", W / 2, H - 40);

writeFileSync(output, c.toBuffer("image/png"));
console.log(`Created: ${output} (${W}×${H})`);
