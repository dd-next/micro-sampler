/* Generate the PWA icons with nothing but Node's own zlib.
   Run: node scripts/make-icons.js                                        */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public');

/* --------------------------------------------------------- tiny PNG out */
function crc32(buf){
  let c, table = crc32.table;
  if (!table){
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++){
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data){
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, rgba){
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // truecolour with alpha
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++){
    raw[y * (width * 4 + 1)] = 0;                       // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------ the icon */
const BG    = [0x0b, 0x0b, 0x12];
const PAD   = [0x1e, 0x1e, 0x2a];
const UV    = [0x9b, 0x6c, 0xff];
const AMBER = [0xf0, 0xa5, 0x3c];
const CYAN  = [0x4f, 0xd4, 0xc4];

// which of the 16 pads are lit, reading left to right, top to bottom
const LIT = { 0:UV, 5:AMBER, 6:AMBER, 9:CYAN, 12:AMBER, 15:UV };

function draw(size){
  const buf = Buffer.alloc(size * size * 4);
  const put = (x, y, c, a) => {
    const i = (y * size + x) * 4;
    const al = a === undefined ? 1 : a;
    buf[i]     = Math.round(buf[i]     * (1 - al) + c[0] * al);
    buf[i + 1] = Math.round(buf[i + 1] * (1 - al) + c[1] * al);
    buf[i + 2] = Math.round(buf[i + 2] * (1 - al) + c[2] * al);
    buf[i + 3] = 255;
  };

  // background with a soft glow up top
  for (let y = 0; y < size; y++){
    for (let x = 0; x < size; x++){
      const dx = (x - size / 2) / size, dy = (y + size * 0.15) / size;
      const g = Math.max(0, 0.55 - Math.sqrt(dx * dx + dy * dy)) * 0.5;
      put(x, y, [BG[0] + g * 90, BG[1] + g * 50, BG[2] + g * 120]);
    }
  }

  // 4x4 pads, rounded, inset from the edge
  const inset = size * 0.14;
  const span  = size - inset * 2;
  const gap   = span * 0.055;
  const cell  = (span - gap * 3) / 4;
  const r     = cell * 0.26;

  for (let n = 0; n < 16; n++){
    const cx = inset + (n % 4) * (cell + gap);
    const cy = inset + Math.floor(n / 4) * (cell + gap);
    const col = LIT[n] || PAD;
    const x0 = Math.floor(cx), y0 = Math.floor(cy);
    const x1 = Math.ceil(cx + cell), y1 = Math.ceil(cy + cell);
    for (let y = y0; y < y1; y++){
      for (let x = x0; x < x1; x++){
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        // rounded-corner coverage, sampled once per pixel centre
        const px = x + 0.5, py = y + 0.5;
        const qx = Math.max(cx + r - px, 0, px - (cx + cell - r));
        const qy = Math.max(cy + r - py, 0, py - (cy + cell - r));
        const d = Math.sqrt(qx * qx + qy * qy);
        if (d > r + 0.7) continue;
        const a = d <= r - 0.5 ? 1 : Math.max(0, Math.min(1, (r + 0.5 - d)));
        put(x, y, col, a);
      }
    }
  }
  return buf;
}

const SIZES = [192, 512];

function writeAll(){
  for (const size of SIZES){
    fs.writeFileSync(path.join(OUT, `icon-${size}.png`), png(size, size, draw(size)));
    console.log(`wrote public/icon-${size}.png`);
  }
  fs.writeFileSync(path.join(OUT, 'icon.svg'), svgSource());
  console.log('wrote public/icon.svg');
}

/* An SVG twin for the browser tab. */
function svgSource(){
const cells = [];
for (let n = 0; n < 16; n++){
  const c = LIT[n];
  const fill = c ? `rgb(${c.join(',')})` : '#1e1e2a';
  cells.push(`<rect x="${(14 + (n % 4) * 19.3).toFixed(1)}" y="${(14 + Math.floor(n / 4) * 19.3).toFixed(1)}" width="14.7" height="14.7" rx="3.8" fill="${fill}"/>`);
}
return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" rx="18" fill="#0b0b12"/>
${cells.join('\n')}
</svg>
`;
}

module.exports = { draw, png, svgSource, writeAll, SIZES };

if (require.main === module) writeAll();
