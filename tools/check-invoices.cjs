const assert = require('node:assert/strict');
const modulePath = require.resolve('../invoice-store.js');
const { categories, open } = require(modulePath);

// This fixture implements the subset of IndexedDB requests used by the ledger.
// Every open and every test file lives in memory, independent of the browser ledger.
function memoryIndexedDB() {
  const stores = new Map();
  const history = new Set();
  const database = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore(name, options = {}) {
      const store = { keyPath: options.keyPath, values: new Map(), indexes: new Map() };
      stores.set(name, store);
      return { createIndex: (index, keyPath) => store.indexes.set(index, keyPath) };
    },
    close() {},
    transaction(names, mode = 'readonly') {
      const tx = {};
      const copies = new Map([].concat(names).map(name => [name, new Map(stores.get(name).values)]));
      let pending = 0;
      let finished = false;
      function complete() {
        setImmediate(() => {
          if (pending || finished) return;
          finished = true;
          if (mode === 'readwrite') {
            for (const [name, values] of copies) stores.get(name).values = values;
          }
          tx.oncomplete?.();
        });
      }
      function request(fn) {
        if (finished) throw new Error('Transaction is inactive');
        const result = {};
        pending++;
        queueMicrotask(() => {
          if (finished) return;
          try {
            result.result = structuredClone(fn());
          } catch (error) {
            result.error = error;
            result.onerror?.();
            tx.error = error;
            tx.abort();
            return;
          }
          result.onsuccess?.();
          pending--;
          complete();
        });
        return result;
      }
      tx.abort = () => {
        if (finished) return;
        finished = true;
        queueMicrotask(() => tx.onabort?.());
      };
      tx.objectStore = name => {
        const values = copies.get(name);
        const schema = stores.get(name);
        return {
          get: key => request(() => values.get(key)),
          getAll: () => request(() => [...values.values()]),
          index(index) {
            const matching = key => [...values.values()].filter(value => value[schema.indexes.get(index)] === key);
            return { get: key => request(() => matching(key)[0]), getAll: key => request(() => matching(key)) };
          },
          put: (value, key = value[schema.keyPath]) => request(() => { values.set(key, structuredClone(value)); return key; }),
          delete: key => request(() => { values.delete(key); }),
        };
      };
      complete();
      return tx;
    },
  };
  return {
    open(name) {
      const request = {};
      queueMicrotask(() => {
        request.result = database;
        if (!history.has(name)) {
          history.add(name);
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });
      return request;
    },
  };
}

function localFile(path, bytes, type) {
  const file = new File([bytes], path.split('/').at(-1), { type, lastModified: Date.parse('2026-10-20T12:00:00Z') });
  return Object.defineProperty(file, 'webkitRelativePath', { value: path });
}

async function checkInvoices() {
  assert.equal(categories.hwy, '高速通行');
  assert.equal(categories.oil, '油票');
  globalThis.indexedDB = memoryIndexedDB();
  const store = await open();
  assert.deepEqual(await store.list(), []);

  const draft = await store.save({ name: '手工录入.pdf', cat: 'other', date: '2026-10-01', amount: 0 });
  assert.equal(draft.amount, 0);
  assert.equal(draft.hasFile, false);
  assert.equal(await store.file(draft.id), null);

  const highway = localFile('发票/01高速/10.20/通行票.pdf', '%PDF-1.4 highway', 'application/pdf');
  const oil = localFile('发票/03已使用/油票/油费票.pdf', '%PDF-1.4 oil', 'application/pdf');
  const mileage = localFile('发票/04里程图/行程图.png', Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), 'image/png');
  const ledger = localFile('发票/_发票台账.json', JSON.stringify({ version: 2, records: [{
    id: 'legacy-oil', name: oil.name, cat: 'oil', status: 'used', amount: 108.53,
    date: '2026-10-18', merchant: '测试商户', note: '测试备注', usedDate: '2026-10-19', usedNote: '测试用途',
  }] }), 'application/json');
  const otherFile = localFile('发票/忽略.txt', 'not an invoice', 'text/plain');
  const imported = await store.importFiles([highway, oil, mileage, ledger, otherFile], 'other');
  assert.equal(imported.added, 3);
  const items = await store.list();
  assert.equal(items.length, 4);
  const byName = name => items.find(item => item.name === name);
  const fromHighway = byName(highway.name);
  assert.equal(fromHighway.cat, 'hwy');
  assert.equal(fromHighway.status, 'unused');
  assert.equal(byName(mileage.name).cat, 'mileage');
  const fromOil = byName(oil.name);
  assert.equal(fromOil.cat, 'oil');
  assert.equal(fromOil.status, 'used');
  assert.equal(fromOil.amount, 108.53);
  assert.equal(fromOil.merchant, '测试商户');
  assert.equal(fromOil.date, '2026-10-18');
  assert.equal(fromOil.note, '测试备注');
  assert.equal(fromOil.usedDate, '2026-10-19');
  assert.equal(fromOil.usedNote, '测试用途');
  assert.equal(fromOil.hasFile, true);
  assert.equal(await (await store.file(fromOil.id)).text(), '%PDF-1.4 oil');
  assert.equal((await store.importFiles([highway], 'other')).added, 0);

  const different = localFile('发票/01高速/another/通行票.pdf', '%PDF-1.4 different highway', 'application/pdf');
  assert.equal((await store.importFiles([different], 'other')).added, 1);
  assert.equal((await store.list()).filter(item => item.name === highway.name).length, 2);
  const pending = localFile('发票/_发票台账.json', JSON.stringify({ version: 2, records: [{
    id: 'legacy-missing', name: '稍后补原件.pdf', cat: 'hwy', status: 'unused', amount: 35, merchant: '测试收费站',
  }] }), 'application/json');
  assert.equal((await store.importFiles([pending], 'other')).added, 1);
  const pendingRecord = (await store.list()).find(item => item.name === '稍后补原件.pdf');
  assert.equal(pendingRecord.hasFile, false);
  const pendingFile = localFile('发票/01高速/稍后补原件.pdf', '%PDF-1.4 pending attachment', 'application/pdf');
  assert.equal((await store.importFiles([pendingFile], 'other')).updated, 1);
  assert.equal((await store.list()).find(item => item.id === pendingRecord.id).amount, 35);
  assert.equal(await (await store.file(pendingRecord.id)).text(), '%PDF-1.4 pending attachment');

  const standaloneFile = new File(['%PDF-1.4 standalone'], '手选油票.pdf', { type: 'application/pdf' });
  const standaloneLedger = new File([JSON.stringify({ version: 2, records: [{
    id: 'legacy-standalone', name: standaloneFile.name, cat: 'oil', status: 'used', amount: 45.5,
  }] })], '_发票台账.json', { type: 'application/json' });
  assert.equal((await store.importFiles([standaloneFile, standaloneLedger], 'other')).added, 1);
  const direct = (await store.list()).filter(item => item.name === standaloneFile.name);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].cat, 'oil');
  assert.equal(direct[0].status, 'used');
  assert.equal(direct[0].amount, 45.5);

  await store.save({ ...fromOil, status: 'unused', usedDate: '', amount: 110, note: '已修改' });
  delete require.cache[modulePath];
  const reloaded = await require(modulePath).open();
  const changed = (await reloaded.list()).find(item => item.id === fromOil.id);
  assert.equal(changed.status, 'unused');
  assert.equal(changed.amount, 110);
  assert.equal(changed.note, '已修改');
  assert.equal(await (await reloaded.file(fromOil.id)).text(), '%PDF-1.4 oil');
  await reloaded.remove(fromOil.id);
  assert.equal(await reloaded.file(fromOil.id), null);
  assert.ok(!(await reloaded.list()).some(item => item.id === fromOil.id));
  console.log('PASS: invoice metadata, nested folder and legacy import, duplicates, attachments, status, persistence, and removal.');
}

checkInvoices().catch(error => { console.error(error); process.exitCode = 1; });
