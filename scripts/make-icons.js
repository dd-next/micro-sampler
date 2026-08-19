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

/* ------------------------------------------------------------ the icon
   The STICKER skin in miniature: a printed case on graph-paper stock,
   four pads, one of them lilac. Flat fills and square corners only, so
   the same geometry describes the PNGs and the SVG twin exactly.        */
const BG    = [0xef, 0xe9, 0xdc];   // case background
const PAPER = [0xfa, 0xf7, 0xf0];   // pad face
const LINE  = [0x0a, 0x0a, 0x0a];   // every outline
const UV    = [0xb6, 0xa4, 0xf5];   // the one lit pad

// all in fractions of the icon, so 192 and 512 come out identical
const CASE = { x0:0.10, x1:0.90, bw:0.035 };
const PAD  = { size:0.255, bw:0.025, at:[0.22, 0.525] };

function draw(size){
  const buf = Buffer.alloc(size * size * 4);
  const rect = (x0, y0, x1, y1, c) => {
    const ix0 = Math.max(0, Math.round(x0 * size)), ix1 = Math.min(size, Math.round(x1 * size));
    const iy0 = Math.max(0, Math.round(y0 * size)), iy1 = Math.min(size, Math.round(y1 * size));
    for (let y = iy0; y < iy1; y++){
      for (let x = ix0; x < ix1; x++){
        const i = (y * size + x) * 4;
        buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
      }
    }
  };
  const outlined = (x0, y0, x1, y1, fill, bw) => {
    rect(x0, y0, x1, y1, LINE);
    rect(x0 + bw, y0 + bw, x1 - bw, y1 - bw, fill);
  };

  rect(0, 0, 1, 1, BG);
  outlined(CASE.x0, CASE.x0, CASE.x1, CASE.x1, PAPER, CASE.bw);
  for (let n = 0; n < 4; n++){
    const x = PAD.at[n % 2], y = PAD.at[Math.floor(n / 2)];
    outlined(x, y, x + PAD.size, y + PAD.size, n === 0 ? UV : PAPER, PAD.bw);
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

/* An SVG twin for the browser tab, drawn from the same fractions. On a
   100-unit canvas an SVG stroke straddles its path, so each rectangle is
   inset by half the outline it carries. */
function svgSource(){
  const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
  const box = (x0, y0, x1, y1, fill, bw) => {
    const h = bw / 2;
    return `<rect x="${((x0 + h) * 100).toFixed(2)}" y="${((y0 + h) * 100).toFixed(2)}" ` +
           `width="${((x1 - x0 - bw) * 100).toFixed(2)}" height="${((y1 - y0 - bw) * 100).toFixed(2)}" ` +
           `fill="${hex(fill)}" stroke="${hex(LINE)}" stroke-width="${(bw * 100).toFixed(2)}"/>`;
  };
  const pads = [];
  for (let n = 0; n < 4; n++){
    const x = PAD.at[n % 2], y = PAD.at[Math.floor(n / 2)];
    pads.push(box(x, y, x + PAD.size, y + PAD.size, n === 0 ? UV : PAPER, PAD.bw));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" fill="${hex(BG)}"/>
${box(CASE.x0, CASE.x0, CASE.x1, CASE.x1, PAPER, CASE.bw)}
${pads.join('\n')}
</svg>
`;
}

module.exports = { draw, png, svgSource, writeAll, SIZES };

if (require.main === module) writeAll();
