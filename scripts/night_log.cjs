'use strict';
// Prints what the app shows for a show night, using engine.js itself:
// {"onset","firstRange":{"at","range"},"confirmed","cleared"}. Reads {day, shows, samples} JSON on stdin.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const box = { window: { addEventListener() {} }, URLSearchParams, AbortController, location: { search: '' },
  document: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} },
  setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout, fetch: async () => ({ ok: false }) };
vm.createContext(box);
vm.runInContext(fs.readFileSync(path.join(root, 'data2024.js'), 'utf8'), box);
vm.runInContext(fs.readFileSync(path.join(root, 'engine.js'), 'utf8'), box);
const doc = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(box.window.exitClock.nightLog(doc, doc.day)) + '\n');
