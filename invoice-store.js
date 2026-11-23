(function (root) {
  'use strict';

  const categories = Object.freeze({hwy:'高速通行', oil:'油票', mileage:'里程图', other:'其他'});
  const types = {
    pdf:'application/pdf', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg',
    gif:'image/gif', webp:'image/webp', bmp:'image/bmp', heic:'image/heic',
    heif:'image/heif', avif:'image/avif',
  };
  const maxAttachmentBytes = 50 * 1024 * 1024;
  const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  const category = value => Object.hasOwn(categories, value) ? value : 'other';
  const extension = name => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const validDate = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? value : '';
  };

  function normalizeRecord(value = {}) {
    const source = value || {};
    const number = typeof source.amount === 'number' ||
      (typeof source.amount === 'string' && source.amount.trim()) ? Number(source.amount) : NaN;
    const cents = Math.round((number + Number.EPSILON) * 100);
    return {
      id: text(source.id, 1500),
      name: text(source.name, 255),
      cat: category(source.cat),
      status: source.status === 'used' ? 'used' : 'unused',
      date: validDate(source.date),
      amount: number >= 0 && Number.isSafeInteger(cents) ? cents / 100 : null,
      merchant: text(source.merchant, 240),
      note: text(source.note, 2000),
      usedDate: validDate(source.usedDate),
      usedNote: text(source.usedNote, 2000),
      hasFile: source.hasFile === true,
    };
  }

  function folderInfo(path, fallback) {
    const folders = String(path || '').split(/[\\/]/).slice(0, -1).map(part => part.trim());
    const usedAt = folders.findIndex(part => /^03\s*已使用$/.test(part));
    const relevant = usedAt === -1 ? folders : folders.slice(usedAt + 1);
    let cat;
    if (relevant.some(part => /^(?:01\s*)?高速(?:通行)?$/.test(part))) cat = 'hwy';
    else if (relevant.some(part => /^(?:02\s*)?油票$/.test(part))) cat = 'oil';
    else if (relevant.some(part => /^(?:04\s*)?里程图$/.test(part))) cat = 'mileage';
    return {cat:cat || category(fallback), status:usedAt === -1 ? 'unused' : 'used',
      hasHint:Boolean(cat) || usedAt !== -1};
  }

  function classifyPath(path, fallback = 'other') {
    const {cat, status} = folderInfo(path, fallback);
    return {cat, status};
  }

  function stampDate(time) {
    const date = new Date(Number(time) + 8 * 3600000);
    return Number.isFinite(time) && time > 0 && Number.isFinite(+date) ? date.toISOString().slice(0, 10) : '';
  }

  const sourceKey = (cat, name) => cat + ':' + name.normalize('NFC').toLowerCase();
  const localId = id => /^(?:invoice|sha256|legacy):/.test(id) ? id : '';
  const request = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function transact(db, mode, run) {
    const tx = db.transaction(['records', 'files'], mode);
    const completed = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || Error('发票保存已取消'));
    });
    try {
      const result = await run(tx.objectStore('records'), tx.objectStore('files'));
      await completed;
      return result;
    } catch (error) {
      try { tx.abort(); } catch {}
      await completed.catch(() => {});
      throw error;
    }
  }

  async function attachment(file, name) {
    const ext = extension(name);
    if (!Object.hasOwn(types, ext) || typeof file?.arrayBuffer !== 'function' || !file.size) {
      throw Error('请选择有内容的 PDF 或图片文件');
    }
    if (file.size > maxAttachmentBytes) throw Error('单份发票原件最大 50 MB');
    if (!root.crypto?.subtle) throw Error('当前浏览器无法校验发票文件，请用 Chrome 或 Edge 打开工作台');
    const bytes = await file.arrayBuffer();
    const hash = await root.crypto.subtle.digest('SHA-256', bytes);
    const digest = Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
    return {digest, blob: file.slice(0, file.size, types[ext])};
  }

  function matchingLedger(ledger, where, name) {
    const comparableName = name.normalize('NFC').toLowerCase();
    const byName = ledger.filter(row => !row.matched && row.name.normalize('NFC').toLowerCase() === comparableName);
    const matches = byName.filter(row => row.cat === where.cat);
    const selected = matches.find(row => row.status === where.status) ||
      (matches.length === 1 ? matches[0] : null) || (!where.hasHint && byName.length === 1 ? byName[0] : null);
    if (selected) selected.matched = true;
    return selected;
  }

  async function parseImport(files, fallback) {
    const ledger = [], documents = [];
    let skipped = 0;
    for (const file of Array.from(files || [])) {
      const name = text(file?.name, 255);
      const ext = extension(name);
      if (ext === 'json') {
        try {
          const body = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
          const records = Array.isArray(body) ? body : body?.records;
          if (!Array.isArray(records)) { skipped++; continue; }
          for (const raw of records) {
            const record = normalizeRecord(raw);
            if (record.name) ledger.push(record);
            else skipped++;
          }
        } catch {
          skipped++;
        }
      } else if (Object.hasOwn(types, ext) && file.size && file.size <= maxAttachmentBytes) {
        documents.push({name, file});
      } else {
        skipped++;
      }
    }
    for (const doc of documents) {
      const where = folderInfo(doc.file.webkitRelativePath || doc.name, fallback);
      const old = matchingLedger(ledger, where, doc.name);
      const status = where.hasHint || !old ? where.status : old.status;
      const cat = where.hasHint || !old ? where.cat : old.cat;
      const date = stampDate(doc.file.lastModified);
      doc.record = normalizeRecord({
        ...old, name: doc.name, cat, status, date: old?.date || date,
        usedDate: status === 'used' ? old?.usedDate || date : '',
      });
      doc.attachment = await attachment(doc.file, doc.name);
      delete doc.file;
    }
    return {documents, ledger:ledger.filter(row => !row.matched), skipped};
  }

  function createStore(db) {
    return {
      list: () => transact(db, 'readonly', async rows => (await request(rows.getAll())).map(normalizeRecord)),
      file: id => transact(db, 'readonly', async (_rows, files) => (await request(files.get(id))) || null),
      async save(record, file) {
        const suppliedId = text(record?.id, 1500);
        const name = text(record?.name || file?.name, 255);
        const attached = file == null ? null : await attachment(file, file.name || name);
        const id = suppliedId || (attached ? 'sha256:' + attached.digest : 'invoice:' + root.crypto.randomUUID());
        return transact(db, 'readwrite', async (rows, files) => {
          const prior = await request(rows.get(id));
          const next = normalizeRecord({...prior, ...record, id, hasFile: Boolean(attached || prior?.hasFile)});
          if (!next.name && name) next.name = name;
          if (!next.name) throw Error('请输入发票名称');
          if (attached) {
            const duplicate = await request(rows.index('digest').get(attached.digest));
            if (duplicate && (!suppliedId || duplicate.id !== id)) throw Error('这份原件已在发票台账中');
            await request(files.put(attached.blob, id));
          }
          await request(rows.put({...next, sourceKey:prior?.sourceKey,
            digest:attached?.digest || prior?.digest}));
          return next;
        });
      },
      remove: id => transact(db, 'readwrite', async (rows, files) => {
        await request(rows.delete(id));
        await request(files.delete(id));
      }),
      async importFiles(files, fallback) {
        const parsed = await parseImport(files, fallback);
        return transact(db, 'readwrite', async (rows, files) => {
          const count = {added:0, updated:0, skipped:parsed.skipped};
          for (const doc of parsed.documents) {
            const {digest, blob} = doc.attachment;
            if (await request(rows.index('digest').get(digest))) { count.skipped++; continue; }
            const key = sourceKey(doc.record.cat, doc.record.name);
            const exactId = localId(doc.record.id);
            const exact = exactId ? await request(rows.get(exactId)) : null;
            const pending = (await request(rows.index('sourceKey').getAll(key))).filter(row => !row.hasFile);
            const prior = exact && !exact.hasFile ? exact :
              pending.find(row => row.status === doc.record.status) || (pending.length === 1 ? pending[0] : null);
            const id = prior?.id || (!exact ? exactId : '') || 'sha256:' + digest;
            const next = normalizeRecord({...doc.record, ...prior, id, hasFile:true});
            await request(rows.put({...next, sourceKey:key, digest}));
            await request(files.put(blob, id));
            count[prior ? 'updated' : 'added']++;
          }
          for (const record of parsed.ledger) {
            const key = sourceKey(record.cat, record.name);
            const exactId = localId(record.id);
            const id = exactId || 'legacy:' + key;
            const prior = await request(rows.get(id));
            const duplicate = !exactId && (await request(rows.index('sourceKey').getAll(key))).length;
            if (prior || duplicate) { count.skipped++; continue; }
            await request(rows.put({...normalizeRecord({...record, id, hasFile:false}), sourceKey:key}));
            count.added++;
          }
          return count;
        });
      },
    };
  }

  let opening;
  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        if (!root.indexedDB) throw Error('当前浏览器无法使用发票本地存储');
        const req = root.indexedDB.open('kejian-workbench-invoices', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          const records = db.createObjectStore('records', {keyPath:'id'});
          records.createIndex('digest', 'digest', {unique:true});
          records.createIndex('sourceKey', 'sourceKey');
          db.createObjectStore('files');
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => { db.close(); opening = undefined; };
          resolve(createStore(db));
        };
        req.onerror = () => reject(req.error);
      }).catch(error => { opening = undefined; throw error; });
    }
    return opening;
  }

  const api = {categories, classifyPath, normalizeRecord, open};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorkbenchInvoiceStore = api;
})(typeof window === 'undefined' ? globalThis : window);
