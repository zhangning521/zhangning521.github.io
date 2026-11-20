"""Build the Pages-safe workbench from the local app; never copy its runtime data."""
from pathlib import Path
import argparse,re,json
parser=argparse.ArgumentParser();parser.add_argument('--source',default=r'D:\OneDrive\HLJY\工作台统计\_教学工作台.html')
args=parser.parse_args();root=Path(__file__).resolve().parent.parent
s=Path(args.source).read_text(encoding='utf-8')
s=re.sub(r'(<script id="wb-data" type="application/json">)[\s\S]*?(</script>)',lambda m:m[1]+'\n'+json.dumps({'meta':{'source':'empty'},'settings':{'termStart':'2026-09-01'},'todos':[],'events':[]},ensure_ascii=False)+'\n'+m[2],s,count=1)
s=s.replace('"wb.teaching.v1"','"kejian.online.v1"').replace('"wb.teaching.calEpoch1"','"kejian.online.calEpoch1"')
start=s.index('const COURSES = [');end=s.index('const MODE_LABEL',start)
s=s[:start]+'''let COURSES = [];
const COURSE_BY_ID = Object.create(null);
function refreshCourseRoster(){
  const roster=settings().courseRoster;
  COURSES=(Array.isArray(roster)?roster:[]).filter(c=>c&&typeof c.id==='string'&&typeof c.name==='string').map(c=>({
    id:c.id,name:c.name.slice(0,100),mode:['offline','online'].includes(c.mode)?c.mode:'',
    keys:(Array.isArray(c.keys)?c.keys:[c.name]).map(String).filter(Boolean),color:/^#[0-9a-f]{6}$/i.test(c.color)?c.color:'#218478'
  }));
  Object.keys(COURSE_BY_ID).forEach(k=>delete COURSE_BY_ID[k]);COURSES.forEach(c=>COURSE_BY_ID[c.id]=c);
}
refreshCourseRoster();
'''+s[end:]
s=s.replace('  if (CAL) { from = addDays(d0(new Date()), -70); to = addDays(d0(new Date()), 240); }','  from=new Date(Math.min(from,addDays(d0(new Date()),-70))); to=new Date(Math.max(to,addDays(d0(new Date()),240)));')
# Disable the local HTTP/JSONP bridge entirely on the publicly hosted app.
start=s.index('/* ========== 本地文件落盘（同步服务在线时） ========== */');end=s.index('/* ========== 事件绑定 / 启动 ========== */',start)
s=s[:start]+(root/'tools/workbench-cloud.js').read_text(encoding='utf-8')+'\n'+s[end:]
s=s.replace('setTimeout(() => { pullStateFromFile().then(() => { stateToFile(); return autoSync(false); }); }, 60);', '''autoSync(false);
setInterval(()=>{if(!document.hidden)autoSync(false);},15*60*1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)autoSync(false);});''')
start=s.index('/* 加载 _calendar_data.js');end=s.index('</script>',start)
s=s[:start]+'''/* The public site starts empty and reads only an explicitly imported backup. */
try { window.__wbInit(null); } catch(error){ console.error('工作台初始化失败',error); }
'''+s[end:]
start=s.index('function renderHead(');end=start+re.search(r'^}',s[start:],re.M).end()
s=s[:start]+'''function renderHead(){
  const count=instances().length;
  $('#sync-pill').classList.toggle('live',count>0);
  $('#sync-text').textContent=cloudTime()?'飞书更新至 '+cloudTime():(count?'浏览器已保存 · '+count+' 项安排':'在线版 · 等待导入或同步');
}
'''+s[end:]
s=s.replace('  renderSvcBox(false);','  renderSvcBox();')
s=s.replace('  S.events = events;','  S.events = events.filter(e=>!(S.added||[]).some(a=>a.id===e.id));\n  refreshCourseRoster();',1)
s=s.replace('settings: settings(), events: rawEvents(), todos: rawTodos(),','settings: Object.assign({},settings(),{courseRoster:COURSES}), events: rawEvents().filter(e=>!e.manual), todos: rawTodos(),',1)
s=s.replace('这是<b>每周重复</b>的课','这是<b>每周重复</b>的课')
s=s.replace('<span class="kk-avatar">黄</span>','<span class="kk-avatar">我</span>')
s=s.replace('同步飞书</button>','同步飞书</button>',1)
s=s.replace('数据与同步','日历同步与备份').replace('<h4>自动同步</h4>','<h4>飞书日历在线更新</h4>')
s=s.replace('<button class="btn" id="svc-auto">开机自启 开/关</button>','<button class="btn" id="svc-auto" hidden>本机设置</button>')
s=s.replace('开启后登录 Windows 自动在后台运行同步服务','无需本机服务，电脑关机后云端仍会按计划同步。')
a=s.index('      <p class="muted" style="font-size:11.5px;line-height:1.7;margin-top:8px">',s.index('<h4>数据保存</h4>'))
b=s.index('</p>',a)+4
s=s[:a]+'''      <p class="muted" style="font-size:11.5px;line-height:1.7;margin-top:8px">修改自动保存在当前浏览器。请定期导出完整备份，清理浏览器数据会移除本机记录。CSV 可从各页面下载；备份不包含飞书密码。</p>'''+s[b:]
a=s.index('    <section>\n      <h4>重新同步</h4>');b=s.index('    </section>',a)+len('    </section>')
s=s[:a]+'''    <section><h4>迁移原工作台</h4><p class="muted">运行工程中的 <b>准备工作台迁移.cmd</b>，会在 private-export 文件夹生成个人迁移文件；也可直接导入原工作台导出的 JSON / ICS。文件只在你选择后由本浏览器读取。</p></section>'''+s[b:]
s=s.replace('清空全部手动修正','清空本浏览器手动修正').replace('恢复示例数据','清空本浏览器数据')
s=s.replace('恢复成文件里的示例数据','清空当前浏览器的工作台').replace('文件内嵌示例','尚未导入')
s=re.sub(r'飞书日历里标题带「[^」]*」的事件会自动归到 6 类课里；认错了点行就能改。','导入日历后课程会显示在这里，点击安排可以修改分类。',s)
s=re.sub(r'(id="ed-name" placeholder=")[^"]*',r'\1例如：线下物理课',s)
s=s.replace('// 外部同步数据（_calendar_data.js，由本地同步服务生成）','// 兼容导入的日历结构')
s=s.replace('${CAL ? "飞书 CalDAV 同步" : "文件内嵌示例"}', '${CAL ? "飞书 CalDAV 同步" : "尚未导入"}')
s=s.replace('<dt>月度 CSV</dt><dd>${months.length} 个月 × 3 个文件（数据/ 文件夹）</dd>','<dt>月度导出</dt><dd>${months.length} 个月 · 各页面可下载 CSV</dd>')
s=s.replace('FEISHU CALENDAR','ONLINE WORKSPACE').replace('课间 · 飞书教学工作台','课间 · 在线教学工作台')
s=s.replace('本机保存 · 自动保留手动修正','浏览器保存 · 自动保留手动修正')
s=s.replace('<script>\nwindow.__wbInit','<script src="calendar-sync.js"></script>\n<script>\nwindow.__wbInit')
s=s.replace('${S.events ? "手动导入" : (CAL ? "飞书 CalDAV 同步" : "尚未导入")}', '${S.feishu ? "飞书 CalDAV 云端同步" : (S.events ? "手动导入" : "尚未导入")}')
s=s.replace('overtime: S.overtime, routes: S.routes','overtime: S.overtime, routes: S.routes, feishu: S.feishu')
s=s.replace('  if (obj.settings) S.settings', '  if (obj.feishu && Number.isFinite(Date.parse(obj.feishu.syncedAt))) S.feishu=obj.feishu;\n  if (obj.settings) S.settings')
s=s.replace('    expenses: e.expenses','    feishu: e.feishu === true,\n    expenses: e.expenses')
s=s.replace('    localStorage.removeItem(KEY);','    localStorage.removeItem(KEY); localStorage.removeItem(CLOUD_KEY); sessionStorage.removeItem(CLOUD_KEY);')

# The online version combines the existing editable todos and a read-only Feishu list.
def replace_once(before, after):
    global s
    if s.count(before) != 1:
        raise ValueError('Expected exactly one workbench template match: ' + before[:100])
    s = s.replace(before, after, 1)

replace_once('const openTodos = rawTodos().filter(t => !t.done);', 'const openTodos = allTodos().filter(t => !t.done);')
replace_once('openTodos.filter(t => t.due && new Date(t.due + "T23:59:59") < now)', 'openTodos.filter(t => todoDeadline(t) < now)')
replace_once('const pending=rawTodos().filter(t=>!t.done).slice().sort((a,b)=>String(a.due||"9999").localeCompare(String(b.due||"9999")));',
             'const pending=allTodos().filter(t=>!t.done).sort((a,b)=>todoDeadline(a)-todoDeadline(b));')
replace_once("pending.length?'按截止时间排列 · 勾选即可完成'", "pending.length?'按截止时间排列'")
replace_once("const overdue=t.due&&new Date(t.due+'T23:59:59')<now;", """const overdue=todoDeadline(t)<now;
    if(isFeishuTodo(t))return `<div class="kk-todo-item kk-task-remote ${overdue?'overdue':''}"><span><strong>${esc(t.title)}</strong><small>飞书任务${t.due?` · <span class="kk-todo-due">${overdue?'已逾期 · ':''}截止 ${todoDueText(t)}</span>`:''}</small></span>${feishuTodoLink(t)}</div>`;""")
replace_once('const list = rawTodos().slice();','const list = allTodos();')
replace_once('String(a.due || "9999").localeCompare(String(b.due || "9999"))', 'todoDeadline(a)-todoDeadline(b)')
replace_once('const over = !t.done && t.due && new Date(t.due + "T23:59:59") < now;',
             '''const over = !t.done && todoDeadline(t) < now;
    if(isFeishuTodo(t))return `<div class="todo kk-task-remote ${over?'overdue':''}"><div class="tx"><b>${esc(t.title)}</b><span>飞书任务${t.due?` · ${over?'已逾期 · ':''}截止 ${todoDueText(t)}`:''}</span></div>${feishuTodoLink(t)}</div>`;''')
replace_once('</style>', '''.kk-task-remote{cursor:default;align-items:center}.kk-task-link{color:var(--accent);flex:none;font-size:11px;padding:8px 0;text-decoration:underline;text-underline-offset:3px}@media(max-width:760px){.kk-task-link{font-size:12px;display:inline-flex;min-height:44px;align-items:center}}
</style>''')
(root/'workbench.html').write_text(s,encoding='utf-8')
print('Built workbench.html with encrypted cloud calendar updates, without embedded personal data or localhost calls.')
