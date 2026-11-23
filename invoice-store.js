(function (root) {
  'use strict';

  const unusedFolder = '02油票';
  const usedPath = ['03已使用', '油票'];
  const ledgerName = '_发票台账.json';
  const receiptName = /^(?![._]).+\.(?:pdf|png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i;
  const lockName = 'kejian-workbench-oil-invoices';
  let queue = Promise.resolve();

  function serialize(run) {
    if (root.navigator?.locks?.request) return root.navigator.locks.request(lockName, run);
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  }

  const missing = error => error?.name === 'NotFoundError';
  const fileDate = timestamp => {
    const date = new Date(timestamp + 8 * 3_600_000);
    return Number.isFinite(+date) ? date.toISOString().slice(0, 10) : '';
  };
  const trimmed = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';
  const validDate = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? value : '';
  };

  function details(value) {
    const number = typeof value.amount === 'number' ||
      (typeof value.amount === 'string' && value.amount.trim()) ? Number(value.amount) : NaN;
    const cents = Math.round((number + Number.EPSILON) * 100);
    return {
      date: validDate(value.date),
      amount: number >= 0 && Number.isSafeInteger(cents) ? cents / 100 : null,
      merchant: trimmed(value.merchant, 240),
      note: trimmed(value.note, 2000),
      usedNote: trimmed(value.usedNote, 2000),
    };
  }

  function originOf(path) {
    if (typeof path !== 'string') return null;
    const parts = path.split('/');
    if (parts[0] !== unusedFolder || parts.length < 2 ||
        parts.some(part => !part || part === '.' || part === '..' || /[\\\u0000]/.test(part)) ||
        !receiptName.test(parts.at(-1))) return null;
    return parts;
  }

  async function directoryAt(rootHandle, parts, create = false) {
    let handle = rootHandle;
    for (const part of parts) handle = await handle.getDirectoryHandle(part, {create});
    return handle;
  }

  async function optionalDirectory(rootHandle, parts) {
    try {
      return await directoryAt(rootHandle, parts);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async function ledgerAt(rootHandle) {
    let handle;
    try {
      handle = await rootHandle.getFileHandle(ledgerName);
    } catch (error) {
      if (missing(error)) return {text: null, source: {version: 2}, records: []};
      throw error;
    }
    const text = await (await handle.getFile()).text();
    let value;
    try {
      value = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      throw Error('发票台账 JSON 无法读取，请检查原文件后重试。');
    }
    if (Array.isArray(value)) return {text, source: {version: 2}, records: value};
    if (!value || !Array.isArray(value.records)) throw Error('发票台账缺少记录列表，请检查原文件。');
    return {text, source: value, records: value.records};
  }

  async function writeFile(handle, contents, beforeWrite) {
    const writer = await handle.createWritable({mode: 'exclusive'});
    try {
      if (beforeWrite) await beforeWrite();
      await writer.write(contents);
      await writer.close();
    } catch (error) {
      try { await writer.abort(); } catch {}
      throw error;
    }
  }

  async function writeLedger(rootHandle, expectedText, nextText) {
    const current = await ledgerAt(rootHandle);
    if (current.text !== expectedText) throw Error('发票台账刚在其他窗口更新，请刷新后再操作。');
    const handle = await rootHandle.getFileHandle(ledgerName, {create: true});
    await writeFile(handle, nextText);
  }

  function ledgerWith(ledger, index, record) {
    const records = ledger.records.slice();
    if (index < 0) records.push(record);
    else records[index] = record;
    return JSON.stringify({...ledger.source, version: 2, updatedAt: new Date().toISOString(), records}, null, 1);
  }

  async function scan(handle, parent, status, found) {
    if (!handle) return;
    for await (const [name, entry] of handle.entries()) {
      const parts = parent.concat(name);
      if (entry.kind === 'directory' && !/^[._]/.test(name)) {
        await scan(entry, parts, status, found);
      } else if (entry.kind === 'file' && receiptName.test(name)) {
        const file = await entry.getFile();
        if (file.size === 0) continue;
        found.push({name, entry, folder: handle, status, path: parts.join('/'),
          size: file.size, mtime: file.lastModified});
      }
    }
  }

  async function readFiles(rootHandle) {
    const unused = await directoryAt(rootHandle, [unusedFolder]);
    const used = await optionalDirectory(rootHandle, usedPath);
    const found = [];
    await scan(unused, [unusedFolder], 'unused', found);
    await scan(used, usedPath, 'used', found);
    return found;
  }

  function withMetadata(found, ledger) {
    const candidates = ledger.records.flatMap((record, index) => record?.cat === 'oil' ? [{record, index}] : []);
    const matched = new Set();
    const ids = new Set();
    const reservedIds = new Set(candidates.map(({record}) => trimmed(record.id, 1500)));
    const result = new Array(found.length);
    function assign(index, candidate) {
      const source = found[index];
      const legacy = candidate?.record;
      if (candidate) matched.add(candidate.index);
      const storedId = trimmed(legacy?.id, 1500);
      let id = storedId;
      if (!id || ids.has(id)) {
        id = 'oil:' + source.path;
        while (ids.has(id) || reservedIds.has(id)) id += ':file';
      }
      ids.add(id);
      const metadata = details(legacy || {});
      const record = {
        id, name: source.name, cat: 'oil', status: source.status,
        ...metadata, date: legacy ? metadata.date : fileDate(source.mtime),
        usedDate: source.status === 'used' ? validDate(legacy?.usedDate) || fileDate(source.mtime) : '',
        size: source.size, mtime: source.mtime, hasFile: true, relativePath: source.path,
      };
      if (source.status === 'used' && originOf(legacy?.originPath)) record.originPath = legacy.originPath;
      result[index] = {record, source, legacy, index: candidate?.index ?? -1};
    }

    // Match precise paths first so that separate receipts with the same filename remain distinct.
    for (const [index, source] of found.entries()) {
      const candidate = candidates.find(row => !matched.has(row.index) && row.record.relativePath === source.path);
      if (candidate) assign(index, candidate);
    }
    function matchUnique(compare) {
      for (const [index, source] of found.entries()) {
        if (result[index]) continue;
        const choices = candidates.filter(row => !matched.has(row.index) && compare(source, row.record));
        if (choices.length !== 1) continue;
        const [candidate] = choices;
        if (found.some((file, other) => other !== index && !result[other] && compare(file, candidate.record))) continue;
        assign(index, candidate);
      }
    }
    // Legacy entries lack a recorded path. Match the status globally before considering a rename or move.
    const sameStatus = (file, row) => file.name === row.name && file.status === row.status;
    matchUnique((file, row) => sameStatus(file, row) && file.size === row.size && file.mtime === row.mtime);
    matchUnique((file, row) => sameStatus(file, row) && file.size === row.size);
    matchUnique(sameStatus);
    matchUnique((file, row) => file.name === row.name);
    for (let index = 0; index < found.length; index++) {
      if (!result[index]) assign(index);
    }
    return result;
  }

  async function snapshot(rootHandle) {
    const [ledger, files] = await Promise.all([ledgerAt(rootHandle), readFiles(rootHandle)]);
    return {ledger, rows: withMetadata(files, ledger)};
  }

  function targetName(name, index) {
    if (!index) return name;
    const dot = name.lastIndexOf('.');
    return name.slice(0, dot) + ' (' + (index + 1) + ')' + name.slice(dot);
  }

  async function reserve(folder, preferred) {
    for (let index = 0; index < 2000; index++) {
      const name = targetName(preferred, index);
      try {
        await folder.getFileHandle(name);
      } catch (error) {
        if (error?.name === 'TypeMismatchError') continue;
        if (!missing(error)) throw error;
        const handle = await folder.getFileHandle(name, {create: true});
        if ((await handle.getFile()).size === 0) return {name, handle};
      }
    }
    throw Error('已使用目录中同名文件过多，无法创建新文件名。');
  }

  async function identical(first, second) {
    if (first.size !== second.size) return false;
    const chunkSize = 1_048_576;
    for (let offset = 0; offset < first.size; offset += chunkSize) {
      const pieces = await Promise.all(
        [first, second].map(file => file.slice(offset, offset + chunkSize).arrayBuffer())
      );
      const a = new Uint8Array(pieces[0]);
      const b = new Uint8Array(pieces[1]);
      if (a.length !== b.length || !a.every((byte, index) => byte === b[index])) return false;
    }
    return true;
  }

  async function currentSource(source, before) {
    const handle = await source.folder.getFileHandle(source.name);
    if (typeof source.entry.isSameEntry === 'function' && !await source.entry.isSameEntry(handle)) {
      throw Error('原文件已被替换。');
    }
    const file = await handle.getFile();
    if (file.size !== before.size || file.lastModified !== before.lastModified) {
      throw Error('原文件在搬运时被修改。');
    }
    return file;
  }

  async function rollbackMove(rootHandle, ledger, newLedger, source, original, folder, target, written) {
    try {
      const current = await currentSource(source, original);
      if (!await identical(current, original)) return false;
      if (newLedger) {
        const prior = ledger.text ?? JSON.stringify({version: 2, records: []});
        await writeLedger(rootHandle, newLedger, prior);
      }
      const targetHandle = await folder.getFileHandle(target.name);
      if (typeof target.handle.isSameEntry === 'function' && !await target.handle.isSameEntry(targetHandle)) return false;
      const targetFile = await targetHandle.getFile();
      if ((written && !await identical(written, targetFile)) || (!written && targetFile.size !== 0)) return false;
      await folder.removeEntry(target.name);
      return true;
    } catch {
      return false;
    }
  }

  function stored(row, record) {
    const { hasFile, ...fields } = record;
    return {...row.legacy, ...fields, originPath: fields.originPath || undefined};
  }

  async function moveFile(rootHandle, ledger, row, used, usedDate) {
    const source = row.source;
    const status = used ? 'used' : 'unused';
    if (source.status === status) return row.record;
    const origin = originOf(row.record.originPath);
    const folderPath = used ? usedPath : origin ? origin.slice(0, -1) : [unusedFolder];
    const preferred = !used && origin ? origin.at(-1) : source.name;
    const original = await source.entry.getFile();
    const folder = await directoryAt(rootHandle, folderPath, true);
    const target = await reserve(folder, preferred);
    let written = null, committed = null, removing = false, claimedTarget = false;
    try {
      await writeFile(target.handle, original, async () => {
        if ((await target.handle.getFile()).size !== 0) throw Error('目标文件名刚被其他窗口占用。');
        claimedTarget = true;
      });
      written = await target.handle.getFile();
      if (!await identical(original, written)) throw Error('目标文件内容校验失败。');
      const relativePath = folderPath.concat(target.name).join('/');
      const record = {
        ...row.record, name: target.name, status, relativePath,
        usedDate: used ? validDate(usedDate) || fileDate(Date.now()) : '',
        size: written.size, mtime: written.lastModified,
        originPath: used ? source.path : undefined,
      };
      const next = ledgerWith(ledger, row.index, stored(row, record));
      await writeLedger(rootHandle, ledger.text, next);
      committed = next;

      const current = await currentSource(source, original);
      const destination = await target.handle.getFile();
      if (!await identical(destination, current)) throw Error('搬运过程中有文件发生变化。');
      removing = true;
      await source.folder.removeEntry(source.name);
      return record;
    } catch (error) {
      if (!claimedTarget) throw Error('无法写入目标文件，原油票已保留。' + (error?.message || ''));
      const rolledBack = await rollbackMove(rootHandle, ledger, committed, source, original, folder, target, written);
      if (rolledBack) throw Error('油票未移动，原文件已保留。' + (error?.message || ''));
      const detail = removing ? '移除原文件时未获得确认，目标文件已保留。' : '操作未完成，已停止移除原文件。';
      throw Error(detail + '请刷新并核对油票和已使用文件夹。');
    }
  }

  async function connect(rootHandle) {
    if (rootHandle?.kind !== 'directory') throw Error('请选择「发票」文件夹。');
    try {
      await directoryAt(rootHandle, [unusedFolder]);
    } catch (error) {
      if (missing(error) || error?.name === 'TypeMismatchError') {
        throw Error('请选择包含「02油票」子文件夹的「发票」文件夹。');
      }
      throw error;
    }
    const lookup = async id => {
      const state = await snapshot(rootHandle);
      const row = state.rows.find(item => item.record.id === id);
      if (!row) throw Error('这张油票已移动或找不到，请刷新目录。');
      return {...state, row};
    };
    return {
      list: () => serialize(async () => (await snapshot(rootHandle)).rows.map(({record}) => record)),
      file: id => serialize(async () => (await lookup(id)).row.source.entry.getFile()),
      save: record => serialize(async () => {
        const {ledger, row} = await lookup(record.id);
        const next = {...row.record, ...details({...row.record, ...record})};
        await writeLedger(rootHandle, ledger.text, ledgerWith(ledger, row.index, stored(row, next)));
        return next;
      }),
      move: (id, used, usedDate) => serialize(async () => {
        const {ledger, row} = await lookup(id);
        return moveFile(rootHandle, ledger, row, Boolean(used), usedDate);
      }),
    };
  }

  const api = {connect};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorkbenchInvoiceStore = api;
})(typeof window === 'undefined' ? globalThis : window);

