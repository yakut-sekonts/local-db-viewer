const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, webPreferences: { offscreen: true } });
  const svg = fs.readFileSync(path.resolve('build/icon.svg'), 'utf8');
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<style>body{margin:0;background:transparent}svg{display:block}</style>${svg}`)}`);
  const rendered = await window.webContents.capturePage();
  const source = nativeImage.createFromBuffer(rendered.toPNG()).resize({ width: 1024, height: 1024 });
  fs.writeFileSync('build/icon.png', source.toPNG());
  fs.mkdirSync('build/icon.iconset', { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) fs.writeFileSync(`build/icon.iconset/icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`, source.resize({ width: size * scale, height: size * scale }).toPNG());
  }
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = sizes.map(size => source.resize({ width: size, height: size }).toPNG());
  const header = Buffer.alloc(6 + images.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, index) => { const start = 6 + index * 16; header[start] = sizes[index] % 256; header[start + 1] = sizes[index] % 256; header.writeUInt16LE(1, start + 4); header.writeUInt16LE(32, start + 6); header.writeUInt32LE(image.length, start + 8); header.writeUInt32LE(offset, start + 12); offset += image.length; });
  fs.writeFileSync('build/icon.ico', Buffer.concat([header, ...images]));
  const icnsEntries = [['icp4', 16], ['icp5', 32], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]].map(([type, size]) => {
    const png = source.resize({ width: size, height: size }).toPNG();
    const entry = Buffer.alloc(8); entry.write(type); entry.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([entry, png]);
  });
  const icnsHeader = Buffer.alloc(8); icnsHeader.write('icns'); icnsHeader.writeUInt32BE(8 + icnsEntries.reduce((total, entry) => total + entry.length, 0), 4);
  fs.writeFileSync('build/icon.icns', Buffer.concat([icnsHeader, ...icnsEntries]));
  window.destroy(); app.quit();
}).catch(error => { console.error(error.message); app.exit(1); });
