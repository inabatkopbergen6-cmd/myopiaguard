/**
 * Contrast audit for the full-screen break screen.
 *
 * The screen composites a sky gradient, two off-centre radial washes, a haze band
 * whose opacity grows as the sun sets, and a land band. Text contrast therefore
 * depends on *where* a thing sits and *when* in the break it is read — so this is
 * computed rather than eyeballed, and it evaluates the worst moment (the glow at
 * full strength) at each element's actual position.
 *
 * Values are parsed from the real CSS, so the audit follows the source rather than
 * a transcription. Run: node scripts/check-contrast.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Comments are stripped before parsing: several are written *inside* declarations
// (documenting a gradient's intent next to its stops), and a parser that keeps them
// sees a comment as a layer.
const read = (rel) =>
  readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const base = read('web/src/styles/base.css');
const windowCss = read('web/src/styles/window.css');

// ---------------------------------------------------------------- colour maths

const parseColor = (text) => {
  const rgb = /rgba?\(([^)]+)\)/.exec(text ?? '');
  if (rgb) {
    const p = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  const hex = /#([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(text ?? '');
  return hex ? { r: parseInt(hex[1], 16), g: parseInt(hex[2], 16), b: parseInt(hex[3], 16), a: 1 } : null;
};

/** Source-over compositing — what a browser does for stacked backgrounds. */
const over = (top, bottom) => ({
  r: top.r * top.a + bottom.r * (1 - top.a),
  g: top.g * top.a + bottom.g * (1 - top.a),
  b: top.b * top.a + bottom.b * (1 - top.a),
  a: 1,
});

const relativeLuminance = ({ r, g, b }) => {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

const contrast = (a, b) => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
};

const rgbText = (c) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;

// -------------------------------------------------------------- CSS extraction

const blockOf = (css, selector) => {
  const m = new RegExp(`${selector.replace(/[.[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`block ${selector} not found`);
  return m[1];
};

const decl = (css, selector, prop) => {
  const m = new RegExp(`${prop}:\\s*([^;]+);`).exec(blockOf(css, selector));
  return m ? m[1].trim() : null;
};

const token = (name) => {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(base + windowCss);
  if (!m) throw new Error(`token --${name} not found`);
  const value = m[1].trim();
  return value.startsWith('var(') ? token(value.slice(6, -1).trim()) : value;
};

/**
 * Splits a multi-layer background on top-level commas only. A regex cannot do this:
 * every gradient contains commas inside its own parentheses (`rgba(r, g, b, a)`,
 * `at 54% 66%, ...`), and splitting on those truncates the layer into fragments with
 * no stops at all.
 */
const splitLayers = (value) => {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out.map((p) => p.trim()).filter(Boolean);
};

const stopsIn = (raw) =>
  [...raw.matchAll(/(rgba?\([^)]+\)|#[0-9a-f]{6})\s+([\d.]+)%/gi)].map((m) => ({
    ...parseColor(m[1]),
    pct: parseFloat(m[2]) / 100,
  }));

/** The `index`-th layer of a multi-layer background, with its radial geometry. */
const layerOf = (css, selector, index) => {
  const layers = splitLayers(decl(css, selector, 'background'));
  const raw = layers[index];
  const geom = /radial-gradient\(([\d.]+)%\s+([\d.]+)%\s+at\s+([\d.]+)%\s+([\d.]+)%/.exec(raw);
  const stops = stopsIn(raw);
  return {
    stops,
    color: stops[0],
    rx: geom ? parseFloat(geom[1]) / 100 : 1,
    ry: geom ? parseFloat(geom[2]) / 100 : 1,
    cx: geom ? parseFloat(geom[3]) / 100 : 0.5,
    cy: geom ? parseFloat(geom[4]) / 100 : 0.5,
  };
};

const sampleLinear = (stops, at) => {
  const sorted = [...stops].sort((a, b) => a.pct - b.pct);
  if (at <= sorted[0].pct) return { ...sorted[0] };
  const last = sorted[sorted.length - 1];
  if (at >= last.pct) return { ...last };
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (at >= a.pct && at <= b.pct) {
      const t = (at - a.pct) / (b.pct - a.pct);
      return {
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
        a: a.a + (b.a - a.a) * t,
      };
    }
  }
  return { ...last };
};

/**
 * A radial layer's alpha at a normalised position. CSS sizes a radial with
 * `rx ry at cx cy`, so the falloff is elliptical: normalise each axis by its own
 * radius, take the distance, and walk the stops along it. Applying a radial at full
 * strength everywhere — the obvious shortcut — makes the audit wildly pessimistic and
 * useless for deciding anything.
 */
const radialAlphaAt = ({ stops, rx, ry, cx, cy }, x, y) => {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  const d = Math.sqrt(dx * dx + dy * dy);
  const sorted = [...stops].sort((a, b) => a.pct - b.pct);
  if (d <= sorted[0].pct) return sorted[0].a;
  const last = sorted[sorted.length - 1];
  if (d >= last.pct) return last.a;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (d >= a.pct && d <= b.pct) {
      const t = (d - a.pct) / (b.pct - a.pct);
      return a.a + (b.a - a.a) * t;
    }
  }
  return last.a;
};

// ------------------------------------------------------------- scene geometry

const skyLinear = stopsIn(decl(windowCss, '.window__sky', 'background')).filter((s) => s.a > 0);
const warmLayer = layerOf(windowCss, '.window__sky', 0);
const mintLayer = layerOf(windowCss, '.window__sky', 1);
const hazeStops = stopsIn(decl(windowCss, '.window__haze', 'background'));
const landStops = stopsIn(decl(windowCss, '.window__land', 'background'));

const hazeTop = parseFloat(decl(windowCss, '.window__haze', 'top')) / 100;
const hazeHeight = parseFloat(decl(windowCss, '.window__haze', 'height')) / 100;
const hazeRadial = layerOf(windowCss, '.window__haze', 0);

// `calc(base + (1 - remaining) * growth)`; at the end of a break `remaining` is 0.
const hazeCalc = decl(windowCss, '.window__haze', 'opacity') ?? '';
const hazeBase = Number(/([\d.]+)\s*\+/.exec(hazeCalc)?.[1] ?? 0.18);
const hazeGrowth = Number(/\*\s*([\d.]+)/.exec(hazeCalc)?.[1] ?? 0.5);
const hazeMaxOpacity = hazeBase + hazeGrowth;

const landTop = parseFloat(decl(windowCss, '.window__land', 'top')) / 100;

/** The composited background at normalised (x, y), with the glow at full strength. */
const backgroundAt = (x, y) => {
  let bg = sampleLinear(skyLinear, y);

  const warmA = radialAlphaAt(warmLayer, x, y);
  if (warmA > 0) bg = over({ ...warmLayer.color, a: warmA }, bg);

  const mintA = radialAlphaAt(mintLayer, x, y);
  if (mintA > 0) bg = over({ ...mintLayer.color, a: mintA }, bg);

  if (y >= hazeTop && y <= hazeTop + hazeHeight) {
    const local = (y - hazeTop) / hazeHeight;
    const a = radialAlphaAt(hazeRadial, x, local) * hazeMaxOpacity;
    if (a > 0) bg = over({ ...hazeRadial.color, a }, bg);
  }

  if (y >= landTop) {
    bg = over(sampleLinear(landStops, (y - landTop) / (1 - landTop)), bg);
  }
  return bg;
};

// ------------------------------------------------------------------- the audit

const text = {
  onDark: parseColor(token('on-dark')),
  onDarkMuted: parseColor(token('on-dark-muted')),
  onDarkAccent: parseColor(token('on-dark-accent')),
  warmNote: parseColor('#ffd9a3'),
  trackBase: parseColor(decl(windowCss, '.window__horizon-line', 'background')),
};

// Positions read from the CSS rather than assumed.
const horizonY = parseFloat(decl(windowCss, '.window__horizon', 'top')) / 100;
const captionY = horizonY + 0.055;
const C = 0.5;

const checks = [
  ['eyebrow (accent token)', text.onDarkAccent, C, 0.17, 4.5],
  ['instruction heading', text.onDark, C, 0.30, 3],
  ['countdown numeral', text.onDark, C, 0.42, 3],
  ['hint text (muted token)', text.onDarkMuted, C, 0.55, 4.5],
  ['long-stretch note (warm)', text.warmNote, C, 0.55, 4.5],
  ['progress track base', text.trackBase, C, horizonY, 3],
  ['progress fill (mint)', parseColor('#7fe0c0'), C, horizonY, 3],
  ['horizon caption', text.onDark, C, captionY, 4.5],
];

console.log('\n  Break screen contrast — computed at the brightest moment of a break');
console.log(
  `  haze: opacity ${hazeMaxOpacity.toFixed(2)} at full glow, band ${(hazeTop * 100).toFixed(0)}%–${((hazeTop + hazeHeight) * 100).toFixed(0)}%`,
);
console.log(`  horizon line at ${(horizonY * 100).toFixed(0)}%, land from ${(landTop * 100).toFixed(0)}%\n`);
console.log('  element                     ratio     need    result   background');
console.log('  ' + '-'.repeat(74));

let failures = 0;
for (const [label, fg, x, y, need] of checks) {
  const bg = backgroundAt(x, y);
  const ratio = contrast(fg, bg);
  const pass = ratio >= need;
  if (!pass) failures += 1;
  console.log(
    `  ${label.padEnd(26)} ${String(ratio).padStart(6)}:1 ${String(need).padStart(4)}:1   ${(pass ? 'pass' : 'FAIL').padEnd(6)} ${rgbText(bg)}`,
  );
}

console.log('');
console.log(failures === 0 ? '  All checks pass.\n' : `  ${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
