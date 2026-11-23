'use strict';

const assert = require('node:assert/strict');
const { connect } = require('../invoice-store.js');

const denied = message => new DOMException(message, 'NotAllowedError');
const missing = name => new DOMException(name, 'NotFoundError');

class MemoryFile {
  constructor(name, body = '') {
    this.kind = 'file';
    this.name = name;
    this.contents = new Blob([body]);
    this.lastModified = Date.parse('2026-11-23T12:00:00+08:00');
  }

  async getFile() {
    return new File([this.contents], this.name, { lastModified: this.lastModified });
  }

  async isSameEntry(other) { return this === other; }

  async createWritable() {
    if (this.denyWritable) throw denied('write fixture');
    let pending;
    return {
      write: async data => {
        if (this.denyWrite) throw denied('write bytes fixture');
        pending = new Blob([data]);
      },
      close: async () => {
        if (this.denyClose) throw denied('close fixture');
        this.contents = this.corruptWrite ? new Blob(['?'.repeat(pending.size)]) : pending;
      },
      abort: async () => { pending = undefined; },
    };
  }
}

class MemoryDirectory {
  constructor(name) {
    this.kind = 'directory';
    this.name = name;
    this.entriesMap = new Map();
    this.beforeRemove = null;
    this.onCreateFile = null;
  }

  directory(name) {
    const entry = new MemoryDirectory(name);
    this.entriesMap.set(name, entry);
    return entry;
  }

  file(name, contents) {
    const entry = new MemoryFile(name, contents);
    this.entriesMap.set(name, entry);
    return entry;
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    const existing = this.entriesMap.get(name);
    if (existing?.kind === 'directory') return existing;
    if (existing) throw new DOMException(name, 'TypeMismatchError');
    if (!create) throw missing(name);
    if (this.denyCreate) throw denied('create directory fixture');
    return this.directory(name);
  }

  async getFileHandle(name, { create = false } = {}) {
    const existing = this.entriesMap.get(name);
    if (existing?.kind === 'file') return existing;
    if (existing) throw new DOMException(name, 'TypeMismatchError');
    if (!create) throw missing(name);
    if (this.denyCreate) throw denied('create file fixture');
    const entry = this.file(name, '');
    this.onCreateFile?.(entry);
    return entry;
  }

  async *entries() { yield* this.entriesMap.entries(); }
  async *values() { yield* this.entriesMap.values(); }
  async *keys() { yield* this.entriesMap.keys(); }
  [Symbol.asyncIterator]() { return this.entries(); }

  async isSameEntry(other) { return this === other; }
  async queryPermission() { return 'granted'; }
  async requestPermission() { return 'granted'; }

  async removeEntry(name) {
    if (!this.entriesMap.has(name)) throw missing(name);
    await this.beforeRemove?.(name);
    this.entriesMap.delete(name);
  }
}

const contents = async (directory, name) => (await (await directory.getFileHandle(name)).getFile()).text();
const ledgerName = '_发票台账.json';

function buildFixture() {
  const root = new MemoryDirectory('发票');
  const oil = root.directory('02油票');
  const unused = oil.directory('未用');
  const archive = root.directory('03已使用');
  const used = archive.directory('油票');
  root.directory('01高速').file('高速.pdf', 'highway');
  archive.directory('高速').file('已用高速.pdf', 'used highway');
  root.directory('04里程图').file('里程.jpg', 'mileage');
  root.file('目录外票据.pdf', 'unrelated');
  oil.file('说明.txt', 'not an invoice');
  unused.file('同名油票.pdf', '%PDF-1.4 new oil invoice');
  used.file('同名油票.pdf', '%PDF-1.4 original archive file');
  used.file('油费历史.pdf', '%PDF-1.4 legacy oil invoice');

  const unrelated = { id: 'old-hwy', name: '高速.pdf', cat: 'hwy', merchant: '测试收费站',
    amount: 35, privateExtra: { category: 'non-oil must survive' } };
  const historical = { id: 'old-oil', name: '油费历史.pdf', cat: 'oil', status: 'used', amount: 108.53,
    date: '2026-10-18', merchant: '测试商户', note: '测试备注', usedDate: '2026-10-19', usedNote: '测试用途' };
  const sameNameArchived = { id: 'old-same-name', name: '同名油票.pdf', cat: 'oil', status: 'used', amount: 88.8,
    merchant: '测试历史商户', usedDate: '2026-11-01' };
  const ledger = { version: 2, fixtureProperty: true, records: [unrelated, historical, sameNameArchived] };
  root.file(ledgerName, JSON.stringify(ledger));
  return { root, oil, unused, used, ledger };
}

async function exerciseMoves() {
  const { root, unused, used, ledger } = buildFixture();
  const store = await connect(root);
  const listed = await store.list();
  assert.equal(listed.length, 3);
  assert(listed.every(row => row.cat === 'oil'));
  const historical = listed.find(row => row.name === '油费历史.pdf');
  assert.equal(historical.status, 'used');
  assert.equal(historical.amount, 108.53);
  assert.equal(historical.merchant, '测试商户');
  assert.equal(historical.note, '测试备注');
  assert.equal(historical.usedNote, '测试用途');
  const pending = listed.find(row => row.status === 'unused');
  assert.equal(pending.name, '同名油票.pdf');
  assert.equal(pending.amount, null, 'The pending file must not pick up ledger data from a same-name archived file');
  const existingArchive = listed.find(row => row.name === pending.name && row.status === 'used');
  assert.equal(existingArchive.amount, 88.8);
  assert.equal(existingArchive.merchant, '测试历史商户');
  assert.equal(await (await store.file(pending.id)).text(), '%PDF-1.4 new oil invoice');

  await store.save({ ...pending, merchant: '测试加油站', amount: 210.58, note: '测试用途', date: '2026-11-23' });
  const edited = (await store.list()).find(row => row.status === 'unused');
  assert.equal(edited.amount, 210.58);
  assert.equal(edited.merchant, '测试加油站');
  assert.equal(edited.date, '2026-11-23');
  assert.equal(edited.note, '测试用途');

  unused.beforeRemove = async name => {
    assert.equal(name, '同名油票.pdf');
    const destination = [...used.entriesMap.keys()].filter(item => !['同名油票.pdf', '油费历史.pdf'].includes(item));
    assert.equal(destination.length, 1, 'Verified destination must exist before deleting the source');
    assert.equal(await contents(used, destination[0]), '%PDF-1.4 new oil invoice');
  };
  await store.move(edited.id, true, '2026-11-23');
  assert.equal(unused.entriesMap.has('同名油票.pdf'), false);
  assert.equal(await contents(used, '同名油票.pdf'), '%PDF-1.4 original archive file');
  const archived = (await store.list()).find(row => row.status === 'used' && row.amount === 210.58);
  assert(archived, 'Moved copy must retain its ledger metadata');
  assert.notEqual(archived.name, pending.name);
  assert.equal(archived.usedDate, '2026-11-23');
  assert.equal(await contents(used, archived.name), '%PDF-1.4 new oil invoice');

  const reopened = await connect(root);
  const afterReopen = (await reopened.list()).find(row => row.name === archived.name);
  assert.equal(afterReopen.amount, 210.58);
  assert.equal(afterReopen.note, '测试用途');
  assert.equal(afterReopen.usedDate, '2026-11-23');
  await reopened.move(afterReopen.id, false, '');
  assert.equal(used.entriesMap.has(archived.name), false);
  const restored = (await reopened.list()).find(row => row.status === 'unused');
  assert.equal(restored.usedDate, '');
  assert.equal(restored.amount, 210.58);
  assert.equal(unused.entriesMap.has(restored.name), true, 'Restore to the original oil subdirectory');
  assert.equal(await (await reopened.file(restored.id)).text(), '%PDF-1.4 new oil invoice');

  const savedLedger = JSON.parse(await contents(root, ledgerName));
  assert.equal(savedLedger.fixtureProperty, true);
  assert.deepEqual(savedLedger.records.find(row => row.cat === 'hwy'), ledger.records[0]);
  assert.equal(savedLedger.records.find(row => row.id === 'old-oil')?.usedNote, '测试用途');
}

async function exerciseFailedMove(setFault) {
  const { root, unused, used, ledger } = buildFixture();
  const store = await connect(root);
  const pending = (await store.list()).find(row => row.status === 'unused');
  setFault({ root, unused, used });
  await assert.rejects(store.move(pending.id, true, '2026-11-23'));
  assert.equal(await contents(unused, pending.name), '%PDF-1.4 new oil invoice');
  assert.equal(await contents(used, pending.name), '%PDF-1.4 original archive file');
  assert.equal(used.entriesMap.size, 2, 'Only the pre-existing files may remain after failure');
  const after = JSON.parse(await contents(root, ledgerName));
  assert.deepEqual(after.records.find(row => row.cat === 'hwy'), ledger.records[0]);
}

async function main() {
  await assert.rejects(connect(new MemoryDirectory('错误的文件夹')));
  await exerciseMoves();
  await exerciseFailedMove(({ used }) => { used.denyCreate = true; });
  await exerciseFailedMove(({ used }) => { used.onCreateFile = entry => { entry.denyWrite = true; }; });
  await exerciseFailedMove(({ used }) => { used.onCreateFile = entry => { entry.corruptWrite = true; }; });
  await exerciseFailedMove(({ root }) => { root.entriesMap.get(ledgerName).denyClose = true; });
  await exerciseFailedMove(({ unused }) => { unused.beforeRemove = () => { throw denied('remove source fixture'); }; });
  console.log('PASS: oil-only directories, ledger preservation, verified moves, name collisions, restoration, and failure rollback.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });

