// Small code-drawn app icon; no remote assets or runtime image dependencies.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type), out = Buffer.alloc(bytes.length + 12);
  out.writeUInt32BE(bytes.length, 0); name.copy(out, 4); bytes.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, bytes])), out.length - 4); return out;
}
const size = 256, scan = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const offset = y * (size * 4 + 1) + 1 + x * 4;
  const dx = Math.max(0, Math.abs(x - 127.5) - 80), dy = Math.max(0, Math.abs(y - 127.5) - 80);
  const inside = dx * dx + dy * dy < 46 * 46;
  let color = [213, 238, 159];
  // Twin linked seats / play mark, matching the Together wordmark's character.
  const screen = x >= 49 && x < 207 && y >= 68 && y < 181;
  const cutout = x >= 60 && x < 196 && y >= 79 && y < 170;
  const triangle = x >= 108 && x <= 158 && Math.abs(y - 124) <= (158 - x) * 0.62;
  const stand = y >= 190 && y < 199 && x >= 98 && x < 158 || x >= 123 && x < 134 && y >= 180 && y < 194;
  if (screen && !cutout || triangle || stand) color = [22, 29, 24];
  scan[offset] = color[0]; scan[offset + 1] = color[1]; scan[offset + 2] = color[2]; scan[offset + 3] = inside ? 255 : 0;
}
const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico[6] = 0; ico[7] = 0; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
fs.mkdirSync(path.join(__dirname, '../assets'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '../assets/icon.png'), png);
fs.writeFileSync(path.join(__dirname, '../assets/icon.ico'), Buffer.concat([ico, png]));
