'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const crypto = require('node:crypto');
const { createInterface } = require('node:readline/promises');
const { encrypt } = require('./encrypt-calendar.cjs');

const apiOrigin = 'https://open.feishu.cn';
const maxTasks = 5000;
const stateFilename = 'authorization.enc.json';
const redirectUri = 'http://127.0.0.1:8765/feishu/callback';

async function feishuRequest(path, options = {}, request = fetch) {
  const response = await request(new URL(path, apiOrigin), {
    ...options, redirect: 'error', signal: AbortSignal.timeout(12000),
  });
  const body = await response.json();
  if (!response.ok || body.code !== 0) {
    const code = Number.isInteger(body.code) ? `，飞书错误码 ${body.code}` : '';
    throw new Error(`飞书接口请求失败（HTTP ${response.status}${code}）`);
  }
  return body;
}

async function requestToken(auth, grant) {
  const result = await feishuRequest('/open-apis/authen/v2/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: auth.appId, client_secret: auth.appSecret, ...grant }),
  });
  if (!result.access_token || !result.refresh_token || !Number.isFinite(result.expires_in)) {
    throw new Error('没有收到完整的用户授权，请检查 offline_access 权限');
  }
  return { accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt: Date.now() + result.expires_in * 1000 };
}

function readConfig(raw) {
  const auth = JSON.parse(raw || '{}');
  if (!auth.appId || !auth.appSecret || !auth.token?.refreshToken || !/^[0-9a-f]{64}$/.test(auth.stateKey || '')) {
    throw new Error('FEISHU_TASK_AUTH 配置不完整');
  }
  return auth;
}

function artifactName(auth) {
  return 'feishu-task-auth-' + crypto.createHash('sha256').update(auth.stateKey).digest('hex').slice(0, 24);
}

function sealToken(token, auth) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(auth.stateKey, 'hex'), iv);
  cipher.setAAD(Buffer.from(artifactName(auth)));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(token), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function openToken(envelope, auth) {
  const payload = Buffer.from(envelope.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(auth.stateKey, 'hex'), Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(artifactName(auth)));
  decipher.setAuthTag(payload.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]).toString('utf8'));
}

const chinaDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

function normalizeTask(task) {
  if (!/^[a-f0-9-]{36}$/i.test(task?.guid || '') || typeof task.summary !== 'string') {
    throw new Error('飞书返回了格式不完整的任务');
  }
  if (Number(task.completed_at || 0) > 0) return null;
  const timestamp = Number(task.due?.timestamp || 0);
  const dueAt = Number.isFinite(timestamp) && timestamp > 0 && !task.due?.is_all_day ? timestamp : null;
  let due = '';
  if (Number.isFinite(timestamp) && timestamp > 0) {
    // Feishu returns a date at 00:00 UTC for all-day tasks.
    due = task.due.is_all_day ? new Date(timestamp).toISOString().slice(0, 10) : chinaDate.format(timestamp);
  }
  return { guid: task.guid.toLowerCase(), title: task.summary.trim() || '未命名任务', due, dueAt };
}

async function collectTasks(accessToken, request) {
  const tasks = new Map();
  const seenPages = new Set();
  const query = new URLSearchParams({ completed: 'false', type: 'my_tasks', page_size: '100' });
  for (let page = 0; page < 100; page++) {
    const { data } = await feishuRequest('/open-apis/task/v2/tasks?' + query, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, request);
    if (!Array.isArray(data?.items) || typeof data.has_more !== 'boolean') throw new Error('飞书任务分页数据不完整');
    for (const item of data.items) {
      const task = normalizeTask(item);
      if (task) tasks.set(task.guid, task);
    }
    if (tasks.size > maxTasks) throw new Error('飞书任务数量超出快照上限');
    if (!data.has_more) return [...tasks.values()];
    if (!data.page_token || seenPages.has(data.page_token)) throw new Error('飞书任务分页未向前推进');
    seenPages.add(data.page_token);
    query.set('page_token', data.page_token);
  }
  throw new Error('飞书任务分页超出上限');
}

async function authorize(file) {
  if (!file) throw new Error('请指定授权文件的本地保存位置');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const appId = (await prompt.question('飞书应用 App ID：')).trim();
  // Use an environment variable supplied through a secure terminal prompt for the secret.
  prompt.close();
  const appSecret = process.env.FEISHU_TASK_APP_SECRET;
  if (!/^cli_[a-z0-9]+$/i.test(appId) || !appSecret) throw new Error('请填写 App ID，并通过 FEISHU_TASK_APP_SECRET 提供 App Secret');
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const authUrl = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
  authUrl.search = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, response_type: 'code', scope: 'task:task:read offline_access', state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  let server;
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('授权等待超时，请重新运行')), 5 * 60 * 1000);
      server = http.createServer((req, res) => {
        const url = new URL(req.url, redirectUri);
        if (req.method !== 'GET' || url.pathname !== '/feishu/callback' || url.searchParams.get('state') !== state) {
          res.writeHead(404).end();
          return;
        }
        clearTimeout(timer);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        const code = url.searchParams.get('code');
        res.end('请返回终端查看飞书任务授权结果。');
        if (code) resolve(code);
        else reject(new Error('飞书任务授权未完成'));
      });
      server.once('error', () => { clearTimeout(timer); reject(new Error('无法启动本机授权回调')); });
      server.listen(8765, '127.0.0.1', () => console.log(`请用浏览器打开以下链接并确认飞书只读授权：\n${authUrl}`));
    });
    const auth = { appId, appSecret, stateKey: crypto.randomBytes(32).toString('hex') };
    auth.token = await requestToken(auth, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
    await collectTasks(auth.token.accessToken);
    await fs.writeFile(file, JSON.stringify(auth), { mode: 0o600, flag: 'wx' });
    console.log('飞书任务读取验证成功。已将授权配置写入指定文件。');
  } finally {
    server?.close();
  }
}

async function main() {
  const [command, input, output] = process.argv.slice(2);
  if (command === 'authorize') return authorize(input);
  const auth = readConfig(process.env.FEISHU_TASK_AUTH);
  if (command === 'name') { console.log(artifactName(auth)); return; }
  const statePath = `${input}/${stateFilename}`;
  let token = auth.token;
  try { token = openToken(JSON.parse(await fs.readFile(statePath, 'utf8')), auth); }
  catch (err) { if (err.code !== 'ENOENT') throw new Error('无法读取加密的任务授权状态'); }
  if (command === 'refresh') {
    if (token.expiresAt > Date.now() + 10 * 60 * 1000) return;
    const rotated = await requestToken(auth, { grant_type: 'refresh_token', refresh_token: token.refreshToken });
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(`${output}/${stateFilename}`, JSON.stringify(sealToken(rotated, auth)), { mode: 0o600 });
    return;
  }
  if (command === 'snapshot') {
    const items = await collectTasks(token.accessToken);
    const snapshot = { taskSync: { syncedAt: new Date().toISOString(), items } };
    await fs.writeFile(output, JSON.stringify(encrypt(snapshot, process.env.CALENDAR_PASSPHRASE)));
    console.log(`已加密同步 ${items.length} 项飞书待办。`);
    return;
  }
  throw new Error('未知的飞书任务命令');
}

if (require.main === module) main().catch(error => {
  // Only deliberately constructed messages are suitable for workflow logs.
  console.error(error instanceof SyntaxError || error instanceof TypeError ? '飞书任务配置或网络请求失败' : error.message);
  process.exitCode = 1;
});

module.exports = { collectTasks, normalizeTask, sealToken, openToken };
