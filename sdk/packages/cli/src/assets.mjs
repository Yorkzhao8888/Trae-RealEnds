/**
 * 品牌资源生成（零依赖）：按主色 + 品牌字样生成 1024 图标与 2732 启动图。
 *
 * 说明：只负责生成「源图」assets/icon.png 与 assets/splash.png；
 * 各平台的多尺寸资源由 @capacitor/assets 在 pack 时生成（模板已带该脚本）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

// ---------------------------------------------------------------- 5×7 点阵
const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
};

// ---------------------------------------------------------------- PNG 编码
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
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
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function parseColor(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return [76, 141, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 生成 PNG。paint(x, y) 返回 null 表示底色，返回 [r,g,b,a] 表示叠加。
 * 底色为不透明主色，避免各平台出现黑边。
 */
function makePng(width, height, bg, paint) {
  const [br, bgc, bb] = bg;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const px = paint ? paint(x, y) : null;
      const o = row + 1 + x * 4;
      raw[o] = px ? px[0] : br;
      raw[o + 1] = px ? px[1] : bgc;
      raw[o + 2] = px ? px[2] : bb;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 字样绘制
function monogram(text) {
  const chars = String(text || 'U').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 6) || 'U';
  return { chars, units: chars.length * 6 - 1 };
}

function textPainter({ chars, units }, width, height, ratioW) {
  const scale = Math.max(2, Math.floor(Math.min((width * ratioW) / units, (height * 0.34) / 7)));
  const gw = units * scale;
  const gh = 7 * scale;
  const x0 = Math.floor((width - gw) / 2);
  const y0 = Math.floor((height - gh) / 2);
  return (x, y) => {
    const gx = x - x0, gy = y - y0;
    if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return null;
    const col = Math.floor(gx / scale);
    const row = Math.floor(gy / scale);
    if (row >= 7) return null;
    const ci = Math.floor(col / 6);
    const cgx = col % 6;
    if (cgx >= 5 || ci >= chars.length) return null;
    const g = FONT[chars[ci]];
    if (!g || g[row][cgx] !== '1') return null;
    return [255, 255, 255];
  };
}

export function assetFiles(dir, { brand, accent, force = false } = {}) {
  const out = join(dir, 'assets');
  mkdirSync(out, { recursive: true });
  const m = monogram(brand);
  const bg = parseColor(accent);
  const targets = [
    { name: 'icon.png', w: 1024, h: 1024, rw: 0.62 },
    { name: 'splash.png', w: 2732, h: 2732, rw: 0.34 },
  ];
  const written = [];
  for (const t of targets) {
    const p = join(out, t.name);
    if (existsSync(p) && !force) continue;
    writeFileSync(p, makePng(t.w, t.h, bg, textPainter(m, t.w, t.h, t.rw)));
    written.push(p);
  }
  return { dir: out, written };
}
