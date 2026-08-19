// Gera assets/icon.png (256x256, RGBA) — um círculo no tom de destaque com um
// "ponto" branco, sem depender de ferramentas externas. PNG codificado à mão.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 256;
const bg = [88, 101, 242]; // #5865f2 (accent)
const dot = [255, 255, 255];

function px(x, y) {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const r = SIZE * 0.46;
  const d = Math.hypot(x - cx, y - cy);
  if (d > r) return [0, 0, 0, 0]; // transparente fora do círculo
  // pontinho branco tipo "bolha de conversa"
  const dd = Math.hypot(x - cx * 1.05, y - cy * 0.95);
  if (dd < SIZE * 0.11) return [dot[0], dot[1], dot[2], 255];
  return [bg[0], bg[1], bg[2], 255];
}

// dados brutos: cada linha começa com filtro 0
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0;
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = px(x, y);
    raw[o++] = r;
    raw[o++] = g;
    raw[o++] = b;
    raw[o++] = a;
  }
}

const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const idat = zlib.deflateSync(raw);
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('icon escrito em', out, png.length, 'bytes');
