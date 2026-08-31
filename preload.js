'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch, p) => ipcRenderer.invoke(ch, p);

contextBridge.exposeInMainWorld('coach', {
  ready: (who) => ipcRenderer.send('renderer:ready', who),

  // capture sources
  listSources: () => invoke('sources:list'),
  selectSource: (id, systemAudio) => invoke('capture:select', { id, systemAudio }),

  // this window
  setIgnoreMouse: (ignore, forward = true) => invoke('overlay:ignore-mouse', { ignore, forward }),
  setFocusable: (v) => invoke('overlay:focusable', v),
  setContentProtection: (v) => invoke('overlay:protect', v),
  setSize: (width, height) => invoke('overlay:size', { width, height }),
  toggleVisible: () => invoke('overlay:hide'),

  // teleprompter window
  prompter: {
    toggle: (show) => invoke('prompter:toggle', show),
    content: (payload) => invoke('prompter:content', payload),
    cfg: (payload) => invoke('prompter:cfg', payload),
    lock: (locked) => invoke('prompter:lock', locked),
    onContent: (fn) => ipcRenderer.on('prompter:content', (_e, p) => fn(p)),
    onCfg: (fn) => ipcRenderer.on('prompter:cfg', (_e, p) => fn(p)),
  },

  // deck import
  importDeck: (wpm) => invoke('deck:import', wpm),
  importPath: (file, wpm) => invoke('deck:import-path', { file, wpm }),
  // Electron no longer exposes File.path; this is the sanctioned replacement.
  pathForFile: (file) => webUtils.getPathForFile(file),

  // files
  recOpen: (payload) => invoke('rec:open', payload),
  recWrite: (data) => invoke('rec:write', data),
  recClose: () => invoke('rec:close'),
  saveSidecar: (payload) => invoke('file:save-sidecar', payload),
  reveal: (p) => invoke('shell:reveal', p),
  openOutputDir: () => invoke('shell:open-dir'),

  // macOS privacy
  perms: () => invoke('perm:status'),
  askPerm: (kind) => invoke('perm:ask', kind),
  openPrivacyPane: (kind) => invoke('perm:open-settings', kind),

  quit: () => invoke('app:quit'),
});
