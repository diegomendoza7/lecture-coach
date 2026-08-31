'use strict';
/*
 * Deck import — turn a real presentation or document into sections + notes.
 *
 * Deliberately free of Electron APIs so it can be unit-tested with plain node
 * (see tools/test-import.js), and free of npm dependencies: macOS already ships
 * everything needed.
 *
 *   .pptx            unzip  -> ppt/slides/slideN.xml + ppt/notesSlides/notesSlideN.xml
 *   .pdf             osascript -l JavaScript -> Quartz PDFDocument, page by page
 *   .docx            unzip  -> word/document.xml (keeps w:pStyle headings)
 *   .doc .rtf .odt   textutil -convert txt
 *   .md .txt         read directly
 *   .json            a deck exported by this app
 *
 * A slide-based source also yields slide cues for free: section N starts on
 * slide N, which is exactly what the slide-change detector auto-advances on.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXEC = { maxBuffer: 128 * 1024 * 1024, timeout: 90000 };
const MAX_SECTIONS = 400;
const WORDS_PER_CHUNK = 170;          // when a document has no headings to split on
const DEFAULT_WPM = 145;

const sh = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, EXEC, (err, stdout, stderr) => {
    if (err) return reject(new Error((stderr || err.message || '').trim().split('\n')[0]));
    resolve(stdout);
  });
});

/* ─────────────────────────────── text utils ─────────────────────────────── */

const unent = (s) => String(s)
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const squash = (s) => String(s).replace(/[ \s]+/g, ' ').trim();
const words = (s) => squash(String(s).replace(/<[^>]+>/g, ' ')).split(' ').filter(Boolean).length;

/** A short line with no sentence punctuation reads as a heading. */
const looksLikeHeading = (line) => {
  const t = squash(line);
  if (!t || t.length > 70) return false;
  if (/[.;:,]$/.test(t)) return false;
  return words(t) <= 10;
};

const titleFrom = (text, fallback) => {
  const t = squash(String(text || '').split('\n').find((l) => squash(l)) || '');
  if (!t) return fallback;
  return (t.length > 58 ? t.slice(0, 56).replace(/\s\S*$/, '') + '…' : t);
};

/* paragraphs -> html; slide bodies are bullets, spoken notes are prose */
function toHtml(paras, kind) {
  const clean = paras.map((p) => (typeof p === 'string' ? { text: p, lvl: 0 } : p))
    .filter((p) => squash(p.text));
  if (!clean.length) return '';
  if (kind === 'bullets') {
    return '<ul>' + clean.map((p) =>
      `<li${p.lvl ? ` style="margin-left:${Math.min(p.lvl, 4) * 18}px"` : ''}>${esc(squash(p.text))}</li>`).join('') + '</ul>';
  }
  return clean.map((p) => `<p>${esc(squash(p.text))}</p>`).join('');
}

/* ────────────────────────────── pdf reflow ───────────────────────────────
 * PDFKit breaks a page into text runs, not lines, so a single phrase can arrive
 * as "O" / "ur approach" / "Stru" / "ctural screen". The next fragment's first
 * character is the tell: a lowercase start means the break is inside a word or a
 * wrapped sentence, an uppercase start means it is a genuine new line. Whether
 * to put a space back depends on how much text preceded the break — a couple of
 * characters is a split glyph run, a full line is a wrapped sentence.
 * ──────────────────────────────────────────────────────────────────────── */

const FRAGMENT_MAX = 8;   // a split glyph run is a few characters, not a line

function reflow(text) {
  const raw = String(text).split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  const out = [];
  for (const line of raw) {
    const prev = out[out.length - 1];
    // A lowercase start means the break is inside a word or a wrapped sentence…
    // …unless the fragment opens with a standalone one-letter token like "p <",
    // which is a new item rather than the rest of a word.
    const startsLower = /^[a-z\u00df-\u00ff]/.test(line) && !/^[a-z][^a-z\u00df-\u00ff]/.test(line);
    if (prev && startsLower && !/[.!?:;]$/.test(prev)) {
      if (/-$/.test(prev)) out[out.length - 1] = prev.slice(0, -1) + line;      // hyphenation
      else out[out.length - 1] = prev + (prev.length <= FRAGMENT_MAX ? '' : ' ') + line;
    } else {
      out.push(line);
    }
  }
  return out.map(squash).filter(Boolean);
}

/* ──────────────────────────────── .pptx ───────────────────────────────── */

const slideNo = (name) => Number((name.match(/(\d+)\.xml$/) || [])[1] || 0);

/** paragraphs of one <p:sp> / notes shape, preserving indent level */
function shapeParas(shapeXml) {
  const out = [];
  const paras = shapeXml.match(/<a:p>[\s\S]*?<\/a:p>|<a:p\s*\/>/g) || [];
  for (const p of paras) {
    const runs = [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unent(m[1]));
    const text = runs.join('');
    if (!squash(text)) continue;
    const lvl = Number((p.match(/<a:pPr[^>]*\blvl="(\d+)"/) || [])[1] || 0);
    out.push({ text, lvl });
  }
  return out;
}

function parseSlide(xml) {
  const shapes = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
  let title = '';
  const body = [];
  for (const sp of shapes) {
    const ph = (sp.match(/<p:ph[^>]*type="([a-zA-Z]+)"/) || [])[1] || '';
    if (/^(sldNum|dt|ftr)$/.test(ph)) continue;                 // page number, date, footer
    const paras = shapeParas(sp);
    if (!paras.length) continue;
    if (!title && /^(title|ctrTitle)$/.test(ph)) title = squash(paras.map((p) => p.text).join(' '));
    else body.push(...paras);
  }
  return { title, body };
}

function parseNotes(xml) {
  const shapes = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
  const out = [];
  for (const sp of shapes) {
    const ph = (sp.match(/<p:ph[^>]*type="([a-zA-Z]+)"/) || [])[1] || '';
    if (/^(sldNum|dt|ftr|sldImg)$/.test(ph)) continue;
    out.push(...shapeParas(sp));
  }
  // a bare number is the slide-number placeholder leaking through
  return out.filter((p) => !/^\d+$/.test(squash(p.text)));
}

async function fromPptx(file) {
  const listing = (await sh('unzip', ['-Z1', file])).split('\n');
  const slides = listing.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => slideNo(a) - slideNo(b));
  if (!slides.length) throw new Error('No slides found inside this .pptx');
  const hasNotes = new Set(listing.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)));

  const sections = [];
  let notesFound = 0;
  for (const name of slides.slice(0, MAX_SECTIONS)) {
    const n = slideNo(name);
    const { title, body } = parseSlide(await sh('unzip', ['-p', file, name]));
    let html = '';
    const notesName = `ppt/notesSlides/notesSlide${n}.xml`;
    if (hasNotes.has(notesName)) {
      const notes = parseNotes(await sh('unzip', ['-p', file, notesName]));
      if (notes.length) { html = toHtml(notes, 'prose'); notesFound++; }
    }
    if (!html) html = toHtml(body, 'bullets');       // fall back to what's on the slide
    sections.push({ title: title || `Slide ${n}`, cue: n, html });
  }
  return {
    title: sections[0] && sections[0].title !== 'Slide 1' ? sections[0].title : path.basename(file, path.extname(file)),
    sections,
    note: notesFound
      ? `${slides.length} slides · speaker notes found on ${notesFound}`
      : `${slides.length} slides · no speaker notes, used the slide text`,
  };
}

/* ───────────────────────────────── .pdf ───────────────────────────────── */

const PDF_JXA = `function run(argv){
  ObjC.import('Quartz');
  var url = $.NSURL.fileURLWithPath(argv[0]);
  var doc = $.PDFDocument.alloc.initWithURL(url);
  if (doc.isNil()) return JSON.stringify({error:'Could not open the PDF'});
  var pages = [];
  for (var i = 0; i < doc.pageCount; i++) {
    var p = doc.pageAtIndex(i);
    var s = p.isNil() ? null : ObjC.unwrap(p.string);
    pages.push(typeof s === 'string' ? s : '');
  }
  return JSON.stringify({pages: pages});
}`;

async function fromPdf(file) {
  const out = await sh('osascript', ['-l', 'JavaScript', '-e', PDF_JXA, file]);
  const parsed = JSON.parse(out.trim());
  if (parsed.error) throw new Error(parsed.error);
  const pages = parsed.pages || [];
  if (!pages.length) throw new Error('That PDF has no pages');

  const chars = pages.reduce((a, p) => a + p.length, 0);
  if (chars < 40) {
    throw new Error('That PDF has no text layer — it is probably a scan. Export a text PDF, or import the original file.');
  }

  // A deck exported to PDF has little text per page; a paper has a lot. Only the
  // former gets slide cues, because only there does page == slide.
  const deckLike = pages.length > 2 && chars / pages.length < 900;
  if (deckLike) {
    return {
      title: titleFrom(reflow(pages[0])[0], path.basename(file, '.pdf')),
      sections: pages.slice(0, MAX_SECTIONS).map((text, i) => {
        const lines = reflow(text);
        return { title: lines[0] ? titleFrom(lines[0], `Slide ${i + 1}`) : `Slide ${i + 1}`, cue: i + 1, html: toHtml(lines.slice(1), 'bullets') };
      }),
      note: `${pages.length} pages, read as slides · cues set`,
    };
  }
  return {
    title: titleFrom(reflow(pages[0])[0], path.basename(file, '.pdf')),
    sections: chunkLines(pages.flatMap((p) => reflow(p))),
    note: `${pages.length} pages, read as a document · no cues (page ≠ slide)`,
  };
}

/* ─────────────────────── blocks -> talk-sized sections ───────────────────
 * Every text-ish format is first flattened into blocks — headings with a level,
 * paragraphs, list items — then split at ONE heading level. Splitting at every
 * level turns a structured document into 69 four-line sections; splitting at the
 * coarsest level that still yields a few sections gives something you can
 * actually rehearse, with the deeper headings kept inline as bold cues.
 * ──────────────────────────────────────────────────────────────────────── */

const MIN_SECTIONS = 3;

function pickSplitLevel(blocks) {
  const levels = blocks.filter((b) => b.kind === 'heading' && b.level > 0).map((b) => b.level);
  if (!levels.length) return null;
  const uniq = [...new Set(levels)].sort((a, b) => a - b);
  for (const L of uniq) if (levels.filter((l) => l <= L).length >= MIN_SECTIONS) return L;
  return uniq[uniq.length - 1];
}

const wrapLists = (html) => html.replace(/(?:<li>[\s\S]*?<\/li>)+/g, (m) => `<ul>${m}</ul>`);

function sectionize(blocks) {
  const split = pickSplitLevel(blocks);
  if (split == null) return null;                       // caller falls back to chunking

  const sections = [];
  let buf = [];
  const open = (title) => { if (sections.length) sections[sections.length - 1].html = wrapLists(buf.join('')); buf = []; sections.push({ title, html: '' }); };

  for (const b of blocks) {
    const text = squash(b.text);
    if (!text) continue;
    if (b.kind === 'heading' && b.level > 0 && b.level <= split) {
      open(titleFrom(text, `Section ${sections.length + 1}`));
    } else {
      if (!sections.length) open('Opening');
      if (b.kind === 'heading') buf.push(`<p><b>${esc(text)}</b></p>`);
      else buf.push(b.list ? `<li>${esc(text)}</li>` : `<p>${esc(text)}</p>`);
    }
  }
  if (sections.length) sections[sections.length - 1].html = wrapLists(buf.join(''));
  return sections;
}

/** A Title-styled block with nothing under it names the deck instead of opening it. */
function liftTitle(sections, fallback) {
  if (sections.length > 1 && !sections[0].html) return { title: sections.shift().title, sections };
  return { title: fallback, sections };
}

/* ──────────────────────────────── .docx ───────────────────────────────── */

const docxLevel = (style) => {
  const m = /^Heading([1-6])$/i.exec(style);
  if (m) return Number(m[1]);
  if (/^Title$/i.test(style)) return 1;
  if (/^Subtitle$/i.test(style)) return 2;
  return null;
};

async function fromDocx(file) {
  const xml = await sh('unzip', ['-p', file, 'word/document.xml']);
  const blocks = [];
  for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []) {
    const text = squash([...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => unent(m[1])).join(''));
    if (!text) continue;
    const level = docxLevel((p.match(/<w:pStyle\s+w:val="([^"]+)"/) || [])[1] || '');
    if (level) blocks.push({ kind: 'heading', level, text });
    else blocks.push({ kind: 'para', text, list: /<w:numPr[ >]/.test(p) });
  }

  const sections = sectionize(blocks);
  const base = path.basename(file, path.extname(file));
  if (!sections) {
    return { title: base, sections: chunkLines(blocks.map((b) => b.text)), note: 'no headings found · split by length' };
  }
  const lifted = liftTitle(sections, base);
  const split = pickSplitLevel(blocks);
  return {
    title: lifted.title,
    sections: lifted.sections.slice(0, MAX_SECTIONS),
    note: `${lifted.sections.length} sections · split at heading level ${split}`,
  };
}

/* ─────────────────────── markdown / plain text / rtf ──────────────────── */

function fromMarkdown(text, fallbackTitle) {
  const blocks = [];
  let docTitle = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!squash(line)) continue;
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (h[1].length === 1 && !blocks.length) { docTitle = squash(h[2]); continue; }
      blocks.push({ kind: 'heading', level: h[1].length, text: h[2] });
      continue;
    }
    const b = line.match(/^\s*[-*+]\s+(.*)$/) || line.match(/^\s*\d+[.)]\s+(.*)$/);
    blocks.push({ kind: 'para', text: b ? b[1] : line, list: !!b, md: true });
  }

  const sections = sectionize(blocks);
  if (!sections) {
    return { title: docTitle || fallbackTitle, sections: chunkLines(blocks.map((b) => b.text)), note: 'no headings found · split by length' };
  }
  // re-apply markdown emphasis, which esc() has left as literal asterisks
  for (const s of sections) s.html = s.html.replace(/\*\*([^*<]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s>])\*([^*<]+)\*/g, '$1<i>$2</i>');
  return { title: docTitle || fallbackTitle, sections: sections.slice(0, MAX_SECTIONS), note: `${sections.length} sections` };
}

/** No headings anywhere: keep paragraphs together in speakable chunks. */
function chunkLines(lines) {
  const paras = lines.map(squash).filter(Boolean);
  const sections = [];
  let cur = null;
  let n = 0;
  for (const p of paras) {
    if (!cur || (n >= WORDS_PER_CHUNK && !looksLikeHeading(p))) {
      cur = { title: titleFrom(p, `Part ${sections.length + 1}`), html: '', _b: [] };
      sections.push(cur);
      n = 0;
    }
    cur._b.push(p);
    n += words(p);
  }
  for (const s of sections) { s.html = s._b.map((t) => `<p>${esc(t)}</p>`).join(''); delete s._b; }
  return sections.slice(0, MAX_SECTIONS);
}

/* ─────────────────────────────── dispatch ────────────────────────────── */

async function importDeck(file, wpm) {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file, ext);
  let deck;

  switch (ext) {
    case '.pptx': deck = await fromPptx(file); break;
    case '.pdf': deck = await fromPdf(file); break;
    case '.docx': deck = await fromDocx(file); break;
    case '.md': case '.markdown': case '.txt':
      deck = fromMarkdown(fs.readFileSync(file, 'utf8'), base); break;
    case '.doc': case '.rtf': case '.rtfd': case '.odt': case '.html': case '.htm': case '.webarchive':
      deck = fromMarkdown(await sh('textutil', ['-convert', 'txt', '-stdout', file]), base); break;
    case '.json': {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw.sections || !raw.sections.length) throw new Error('That .json is not a Lecture Coach deck');
      deck = { title: raw.title || base, sections: raw.sections, note: `${raw.sections.length} sections` };
      break;
    }
    case '.key':
      throw new Error('Keynote files are not readable directly. In Keynote choose File → Export To → PowerPoint (or PDF) and import that.');
    case '.ppt':
      throw new Error('Legacy .ppt is not supported. Open it and save as .pptx, or export a PDF.');
    default:
      throw new Error(`Cannot read ${ext || 'that file'} yet. Try .pptx, .pdf, .docx, .md or .txt.`);
  }

  // Normalise, then give every section a target from its own word count.
  deck.sections = deck.sections
    .filter((s) => s && (squash(s.title) || s.html))
    .slice(0, MAX_SECTIONS)
    .map((s, i) => ({
      id: Math.random().toString(36).slice(2, 9),
      title: squash(s.title) || `Section ${i + 1}`,
      html: String(s.html || '').slice(0, 20000),
      target: s.target || Math.max(20, Math.round((words(s.html) / (wpm > 40 ? wpm : DEFAULT_WPM)) * 60)),
      ...(s.cue ? { cue: s.cue } : {}),
    }));

  if (!deck.sections.length) throw new Error('Nothing readable came out of that file');
  deck.title = squash(deck.title) || base;
  deck.source = path.basename(file);
  return deck;
}

module.exports = { importDeck };
