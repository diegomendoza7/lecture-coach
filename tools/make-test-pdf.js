// Generates two PDF fixtures: a slide-like deck and a prose document.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const path = require('path');
const out = process.argv[2] || '.';
const deck = `<style>body{font:44px/1.3 system-ui;margin:0}
section{height:100vh;padding:8vh 6vw;box-sizing:border-box;page-break-after:always}
h1{font-size:60px;margin:0 0 24px}li{margin:12px 0}</style>
<section><h1>Kinase selectivity</h1><ul><li>Off-target toxicity</li><li>Three failed trials</li></ul></section>
<section><h1>Our approach</h1><ul><li>Structural screen</li><li>Cryo-EM validation</li></ul></section>
<section><h1>Results</h1><ul><li>40% improvement</li><li>p &lt; 0.001</li></ul></section>
<section><h1>Takeaways</h1><ul><li>Selectivity is kinetic</li></ul></section>`;
const paper = `<style>body{font:13px/1.6 Georgia;margin:0;padding:60px}p{margin:0 0 12px;text-align:justify}</style>` +
  Array.from({length: 26}, (_, i) => `<p>Paragraph ${i + 1}. ` + 'The measured effect persisted across replicates and conditions, which constrains the mechanism substantially. '.repeat(4) + `</p>`).join('');
app.on('window-all-closed', () => {});   // destroying the last window would start a quit
app.whenReady().then(async () => {
  try {
  console.log('argv:', JSON.stringify(process.argv.slice(1)), 'out=', out);
  for (const [name, html] of [['deck.pdf', deck], ['paper.pdf', paper]]) {
    const w = new BrowserWindow({ show: false, width: 1280, height: 720 });
    const tmp = path.join(out, `tmp_${name.replace('.pdf','')}.html`);   // data: URLs blow past the URL length limit
    fs.writeFileSync(tmp, html);
    await w.loadFile(tmp);
    const buf = await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4', landscape: name === 'deck.pdf' });
    fs.writeFileSync(path.join(out, name), buf);
    console.log('wrote', name, buf.length, 'bytes');
    w.destroy();
    fs.unlinkSync(tmp);
  }
  app.exit(0);
  } catch (e) { console.error('FAILED:', e && (e.stack || e.message)); app.exit(1); }
});
