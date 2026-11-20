/* Pages reads ciphertext only. Browser edits remain local. */
function stateToFile() {}
const pushFiles=stateToFile;
const CLOUD_KEY='kejian.feishu.passphrase.v1';
let cloudBusy=false,cloudError='',taskError='';
const feishuTodos=()=>S.feishuTasks?.items||[];
const allTodos = () => rawTodos().concat(feishuTodos().map(todo =>
  S.feishuTodoDone?.[todo.id] ? { ...todo, done: true } : todo));
const isFeishuTodo=t=>t.source==='feishu-task';
const todoDeadline=t=>t.dueAt??(t.due?new Date(t.due+'T23:59:59').getTime():Infinity);
const todoTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false});
function todoDueText(todo){
  return esc(todo.due)+(todo.dueAt!==null&&todo.dueAt!==undefined?' '+todoTime.format(todo.dueAt):'');
}
function feishuTodoLink(todo){
  return `<a class="kk-task-link" href="https://applink.feishu.cn/client/todo/detail?guid=${encodeURIComponent(todo.guid)}" target="_blank" rel="noopener noreferrer">在飞书处理 ↗</a>`;
}
function cloudPassphrase(){try{return localStorage.getItem(CLOUD_KEY)||sessionStorage.getItem(CLOUD_KEY)||'';}catch(e){return '';}}
function cloudTime(){return S.feishu&&S.feishu.syncedAt?new Date(S.feishu.syncedAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'';}
async function autoSync(force){
  if(cloudBusy)return;
  const input=$('#cloud-passphrase');
  const phrase=input&&input.value?input.value:cloudPassphrase();
  if(!phrase){if(force){openData();$('#cloud-passphrase').focus();}return;}
  cloudBusy=true;cloudError='';taskError='';
  $('#sync-text').textContent='正在读取飞书日历…';
  const button=$('#kk-sync');button.disabled=true;
  const inDialog=$('#dlg').open;
  try{
    const taskRequest=window.KejianCalendar.fetchTasks(phrase).catch(()=>{
      taskError='暂时无法读取飞书任务，保留上次的待办。';return null;
    });
    const data=await window.KejianCalendar.fetchSnapshot(phrase);
    S=window.KejianCalendar.merge(S,data);
    const tasks=await taskRequest;
    if(tasks&&!(Date.parse(S.feishuTasks?.syncedAt)>Date.parse(tasks.syncedAt)))S.feishuTasks=tasks;
    // Store the decryption phrase only on this device, after it has successfully decrypted a snapshot.
    try{
      if(inDialog&&$('#cloud-remember')?.checked){localStorage.setItem(CLOUD_KEY,phrase);sessionStorage.removeItem(CLOUD_KEY);}
      else if(!localStorage.getItem(CLOUD_KEY))sessionStorage.setItem(CLOUD_KEY,phrase);
    }catch(e){}
    save();invalidate();render();
    if(inDialog)openData();
    if(force)toast(taskError||(tasks?'飞书日历与待办已更新':'飞书日历已更新至 '+cloudTime()));
  }catch(error){
    cloudError=error.message||'更新失败，原课表已保留。';
    renderHead();
    if(force){if(!$('#dlg').open)openData();else renderSvcBox();toast(cloudError);}
  }finally{
    cloudBusy=false;button.disabled=false;
    if($('#dlg').open)renderSvcBox();
  }
}
function renderSvcBox(){
  $('#svc-box').innerHTML=`<div class="svcline">飞书 CalDAV · GitHub 定时更新 · 加密日历</div>
    <p class="muted" style="margin:8px 0;line-height:1.7">云端计划每 15 分钟读取一次日历，GitHub 调度和发布可能延迟。${cloudTime()?'当前日历更新至 <b>'+esc(cloudTime())+'</b>。':'首次使用需输入网页解密口令。'}网页打开后自动检查，也可点击“同步飞书”读取最新已发布的数据。</p>
    <label class="fld"><span>网页解密口令（不是飞书密码）</span><input id="cloud-passphrase" type="password" minlength="16" autocomplete="off" placeholder="与仓库 CALENDAR_PASSPHRASE 相同，至少 16 个字符" style="width:100%"></label>
    <label style="display:block;margin:10px 0;font-size:12px"><input id="cloud-remember" type="checkbox" ${localStorage.getItem(CLOUD_KEY)?'checked':''}> 记住此浏览器，下次自动更新</label>
    <div class="row"><button id="cloud-update" class="btn primary" ${cloudBusy?'disabled':''}>${cloudBusy?'正在更新…':'解锁并更新课表'}</button><button id="cloud-forget" class="btn">忘记本机口令</button></div>
    ${cloudError?'<p role="alert" style="color:var(--warn);margin-top:10px">'+esc(cloudError)+'</p>':''}
    <p class="muted" style="margin-top:8px">${taskError?esc(taskError):S.feishuTasks?`飞书任务 · ${esc(new Date(S.feishuTasks.syncedAt).toLocaleString('zh-CN'))} · ${feishuTodos().length} 项未完成`:'飞书任务同步尚未连接。'}</p>
    <p class="muted" style="margin-top:10px;line-height:1.7;font-size:11px">日历在浏览器中解密，口令不会发送到网站；报销、调休标记和手动修正保存在当前浏览器。这里读取的是最近一次云端同步结果，不会立即触发 GitHub 任务。</p>
    <details style="margin-top:10px"><summary>首次配置 / 查看同步任务</summary><p class="muted" style="line-height:1.7">在 GitHub 仓库的 Secrets 中配置 FEISHU_CALDAV_USERNAME、FEISHU_CALDAV_PASSWORD 和 CALENDAR_PASSPHRASE。后者请设为至少 16 个字符的独立口令，随后运行一次同步任务。</p><p><a href="https://github.com/zhangning521/zhangning521.github.io/settings/secrets/actions" target="_blank" rel="noopener">配置仓库 Secrets ↗</a> · <a href="https://github.com/zhangning521/zhangning521.github.io/actions/workflows/pages.yml" target="_blank" rel="noopener">查看 / 手动运行同步任务 ↗</a></p></details>`;
  $('#cloud-update').onclick=()=>autoSync(true);
  $('#cloud-forget').onclick=()=>{try{localStorage.removeItem(CLOUD_KEY);sessionStorage.removeItem(CLOUD_KEY);}catch(e){}cloudError='';renderSvcBox();toast('已忘记本机解密口令，课表和标记保留');};
}
function bindAutoBtn(){}
