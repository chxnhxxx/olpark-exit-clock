'use strict';
// Weekday-dependent session times written in the official schedule's free text.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const box = { Date, URLSearchParams, AbortController, location: { search: '' }, console,
  document: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} },
  setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, fetch: () => new Promise(() => {}) };
box.window = box; box.addEventListener = () => {};
vm.createContext(box);
vm.runInContext(fs.readFileSync('data2024.js', 'utf8'), box);
vm.runInContext(fs.readFileSync('engine.js', 'utf8'), box);
const hhmm = t => t === null ? '미정' : new Date(t + 9 * 3600000).toISOString().slice(11, 16);
const starts = (tm, day) => box.exitClock.showsForDay([{ title: 't', plc: 'p', beginDt: '2027-01-01', endDt: '2027-07-03', tm, ndTm: '70분' }], day)
  .map(s => hhmm(s.start)).join(',');
const cases = [
  ['평일(수), (목), (금) 11시 / 주말(토), (일) 14시', { '2027-01-06': '11:00', '2027-01-08': '11:00', '2027-01-09': '14:00', '2027-01-10': '14:00', '2027-01-11': '' }],
  ['평일(수,목,금) 11시, 14시 / 토 11시, 14시, 16시30분 / 일 14시 (월,화 휴관)', { '2027-01-05': '', '2027-01-06': '11:00,14:00', '2027-01-09': '11:00,14:00,16:30', '2027-01-10': '14:00' }],
  ['주말 및 공휴일 14시 ', { '2027-01-02': '14:00', '2027-01-04': '' }],
  ['화~금 오후 8시 / 토 3시, 7시 / 일 2시, 6시 / 월 공연 없음', { '2027-01-04': '', '2027-01-05': '20:00', '2027-01-09': '15:00,19:00' }],
  ['수,목,금 19:30 | 토,일 14:00, 18:00', { '2027-01-06': '19:30', '2027-01-09': '14:00,18:00' }],
];
for (const [tm, expected] of cases)
  for (const [day, want] of Object.entries(expected)) assert.equal(starts(tm, day), want, tm + ' @ ' + day);
console.log('PASS weekday session times (평일/주말, bracketed day lists, multiple sessions, closed days)');
