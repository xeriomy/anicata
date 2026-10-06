/**
 * Generates `public/logo.png`.
 *
 * Why this exists: the repository shipped a 1x1, 67-byte placeholder PNG. It
 * satisfied every assertion the integration test made (`status 200`,
 * `content-type: image/png`, `body.length > 0`), so the test passed while Nuvio
 * rendered an empty tile in the add-on list. A placeholder that passes the test
 * is worse than a missing file, because it hides the defect.
 *
 * No image dependency is added. A PNG is a signature, three chunks and zlib-
 * deflated scanlines, so it is written directly here using Node's built-in
 * `zlib`. Run with: `node scripts/generate-logo.mjs`
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 512;
const SS = 3; // supersampling factor per axis, for antialiased edges

/** Brand palette, matching the app's dark violet identity. */
const BG_TOP = [0x1b, 0x1a, 0x2e];
const BG_BOTTOM = [0x0d, 0x0c, 0x18];
const ACCENT = [0x8b, 0x6c, 0xff]; // violet - the "A" strokes
const ACCENT_2 = [0x22, 0xd3, 0xee]; // cyan - the crossbar

/** CRC-32, as PNG chunks require. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Signed distance from a point to a rounded rectangle centred at (cx, cy).
 * Negative inside. Lets the corner radius be expressed exactly rather than by
 * testing pixels near a corner.
 */
function roundedRectSdf(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ax, ay) - radius;
}

/** Distance from a point to a line segment, used to draw the "A" strokes. */
function segmentSdf(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const wx = px - x1;
  const wy = py - y1;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  return Math.hypot(wx - t * vx, wy - t * vy);
}

/** Linear interpolation between two RGB triples. */
function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

const N = SIZE * SS;
const cx = N / 2;
const cy = N / 2;
const half = N * 0.46; // leave a transparent margin for the rounded corners
const radius = N * 0.22;

// "A" geometry, in supersampled units.
const apexX = cx;
const apexY = N * 0.29;
const leftX = N * 0.325;
const rightX = N * 0.675;
const baseY = N * 0.735;
const strokeW = N * 0.052;
const crossbarY = N * 0.6;
const crossbarHalf = N * 0.098;

// Accumulate colour with 3x3 supersampling, then average.
const rgba = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;

    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x * SS + sx + 0.5;
        const py = y * SS + sy + 0.5;

        if (roundedRectSdf(px, py, cx, cy, half, half, radius) > 0) continue; // outside

        // Background: vertical gradient.
        let [cr, cg, cb] = mix(BG_TOP, BG_BOTTOM, py / N);

        // Crossbar first, so the legs sit on top of it.
        const dCross = segmentSdf(px, py, cx - crossbarHalf, crossbarY, cx + crossbarHalf, crossbarY);
        if (dCross <= strokeW * 0.42) {
          [cr, cg, cb] = mix(ACCENT_2, ACCENT, 0.15);
        }

        // The two legs of the "A".
        const dLegs = Math.min(
          segmentSdf(px, py, apexX, apexY, leftX, baseY),
          segmentSdf(px, py, apexX, apexY, rightX, baseY),
        );
        if (dLegs <= strokeW * 0.5) {
          // Vertical gradient along the legs for depth.
          [cr, cg, cb] = mix(ACCENT, [0xff, 0xff, 0xff], 0.12 * (1 - py / N));
        }

        r += cr;
        g += cg;
        b += cb;
        a += 255;
      }
    }

    const samples = SS * SS;
    const i = (y * SIZE + x) * 4;
    const alpha = a / samples;
    if (alpha > 0) {
      // Un-premultiply so edge pixels keep their colour as coverage falls off.
      const coverage = a / 255;
      rgba[i] = Math.round(r / coverage);
      rgba[i + 1] = Math.round(g / coverage);
      rgba[i + 2] = Math.round(b / coverage);
    }
    rgba[i + 3] = Math.round(alpha);
  }
}

// Prefix every scanline with filter type 0 (None).
const rawImage = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  rawImage[y * (SIZE * 4 + 1)] = 0;
  rgba.copy(rawImage, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); // width
ihdr.writeUInt32BE(SIZE, 4); // height
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(rawImage, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'public', 'logo.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);

console.log(`wrote ${out} - ${SIZE}x${SIZE}, ${png.length} bytes`);
