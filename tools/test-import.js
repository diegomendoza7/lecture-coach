#!/usr/bin/env node
/* Structural test of importer.js. Pass --quiet to print counts only (for files
   whose contents should not be echoed). */
const { importDeck } = require('../importer');
const path = require('path');

const quiet = process.argv.includes('--quiet');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));

(async () => {
  let fail = 0;
  for (const f of files) {
    try {
      const d = await importDeck(f);
      const cues = d.sections.filter((s) => s.cue).length;
      const chars = d.sections.reduce((a, s) => a + s.html.length, 0);
      const plan = d.sections.reduce((a, s) => a + s.target, 0);
      console.log(`\n${path.basename(f)}  →  ${d.sections.length} sections, ${cues} cues, ${chars} html chars, plan ${Math.round(plan / 60)}min`);
      console.log(`  note: ${d.note}`);
      if (!quiet) {
        console.log(`  title: ${d.title}`);
        d.sections.forEach((s, i) =>
          console.log(`   ${String(i + 1).padStart(2)}. [cue ${s.cue ?? '-'}] ${JSON.stringify(s.title).slice(0, 46).padEnd(48)} ${String(s.target).padStart(4)}s  ${s.html.slice(0, 70)}`));
      }
    } catch (e) {
      console.log(`\n${path.basename(f)}  →  ERROR: ${e.message}`);
      fail++;
    }
  }
  process.exit(fail ? 1 : 0);
})();
