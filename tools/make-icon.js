'use strict';
/* Renders build/icon.png (1024²) offscreen — no image tooling required.
   `npm run icon` turns it into build/icon.icns. */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#252d42"/><stop offset="1" stop-color="#0b0e15"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".14"/>
      <stop offset=".45" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="26" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <rect x="100" y="100" width="824" height="824" rx="188" fill="url(#bg)"/>
  <rect x="100" y="100" width="824" height="824" rx="188" fill="url(#sheen)"/>
  <rect x="102.5" y="102.5" width="819" height="819" rx="186" fill="none"
        stroke="#ffffff" stroke-opacity=".16" stroke-width="5"/>

  <!-- the dashboard pill -->
  <rect x="232" y="404" width="560" height="216" rx="108"
        fill="#ffffff" fill-opacity=".07" stroke="#ffffff" stroke-opacity=".18" stroke-width="4"/>

  <!-- record dot -->
  <circle cx="342" cy="512" r="56" fill="#ff4d5e" filter="url(#glow)"/>

  <!-- notes lines -->
  <rect x="440" y="474" width="292" height="28" rx="14" fill="#ffffff" fill-opacity=".92"/>
  <rect x="440" y="536" width="188" height="28" rx="14" fill="#ffffff" fill-opacity=".45"/>
</svg>`;

const page = `<body style="margin:0;width:1024px;height:1024px;background:transparent">${svg}</body>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, transparent: true, frame: false,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage();
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.writeFileSync(out, img.toPNG());
  console.log('wrote', out, img.getSize());
  app.exit(0);
});
