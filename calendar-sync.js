/* Calendar snapshots are decrypted here; the CalDAV password never reaches this page. */
(function(root){
  'use strict';
  const decode=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  function snapshot(value){
    const m=value&&value.meta;
    if(!m||m.source!=='caldav'||m.complete!==true||!Array.isArray(m.calendars)||!m.calendars.every(c=>typeof c==='string')||!Array.isArray(value.events)||value.events.length>5000)throw Error('日历数据不完整，本次保留原数据。');
    const from=Date.parse(m.rangeStart),to=Date.parse(m.rangeEnd);
    if(!Number.isFinite(from)||!Number.isFinite(to)||from>=to||!Number.isFinite(Date.parse(m.syncedAt)))throw Error('日历时间范围无效。');
    const ids=new Set();
    const events=value.events.map(e=>{
      if(!e||typeof e.id!=='string'||!e.id||ids.has(e.id)||!m.calendars.includes(e.calendar)||!Number.isFinite(Date.parse(e.start))||!Number.isFinite(Date.parse(e.end))||Date.parse(e.end)<Date.parse(e.start)||Date.parse(e.start)<from||Date.parse(e.start)>to)throw Error('日历事件校验失败，本次保留原数据。');
      ids.add(e.id);
      return {id:e.id,uid:e.uid||e.id,title:String(e.title||'(无标题)'),start:e.start,end:e.end,allDay:!!e.allDay,location:String(e.location||''),description:String(e.description||''),calendar:e.calendar,feishu:true};
    });
    return {meta:m,events};
  }
  function merge(state,value){
    const data=snapshot(value),names=new Set(data.meta.calendars),incoming=new Set(data.events.map(e=>e.id));
    if(state.feishu&&Date.parse(state.feishu.syncedAt)>Date.parse(data.meta.syncedAt))throw Error('线上快照早于当前课表，已保留较新的数据。');
    const from=Date.parse(data.meta.rangeStart),to=Date.parse(data.meta.rangeEnd);
    const keep=(state.events||[]).filter(e=>{
      if(incoming.has(e.id))return false;
      const t=Date.parse(e.start);
      return !((e.feishu===true||names.has(e.calendar))&&t>=from&&t<=to);
    });
    const added=new Set((state.added||[]).map(e=>e.id));
    return Object.assign({},state,{events:keep.concat(data.events).filter(e=>!added.has(e.id)),feishu:{syncedAt:data.meta.syncedAt,count:data.events.length,rangeStart:data.meta.rangeStart,rangeEnd:data.meta.rangeEnd,calendars:data.meta.calendars}});
  }
  async function decryptPayload(envelope,passphrase){
    if(!envelope||envelope.version!==1||envelope.algorithm!=='AES-256-GCM'||envelope.iterations!==310000||typeof passphrase!=='string'||passphrase.length<16)throw Error('请输入至少 16 个字符的网页解密口令。');
    const salt=decode(envelope.salt),iv=decode(envelope.iv),body=decode(envelope.ciphertext);
    if(salt.length!==16||iv.length!==12||body.length<16||body.length>16*1024*1024)throw Error('加密日历格式无效。');
    const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(passphrase),'PBKDF2',false,['deriveKey']);
    const key=await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:envelope.iterations},base,{name:'AES-GCM',length:256},false,['decrypt']);
    let text;
    try{text=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('kejian.feishu.v1')},key,body);}catch(e){throw Error('口令不匹配或数据损坏，原课表未改动。');}
    return JSON.parse(new TextDecoder().decode(text));
  }
  async function decrypt(envelope,passphrase){
    return snapshot(await decryptPayload(envelope,passphrase));
  }
  async function fetchEnvelope(filename){
    let response;
    try{response=await fetch('./calendar/'+filename+'?t='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(20000)});}catch(e){throw Error('暂时无法读取飞书同步数据，请稍后重试。');}
    if(response.status===404)return null;
    if(!response.ok)throw Error('读取飞书同步数据失败（'+response.status+'）。');
    return response.json();
  }
  async function fetchSnapshot(passphrase){
    const envelope=await fetchEnvelope('feishu.enc.json');
    if(!envelope)throw Error('尚未生成云端日历：请先配置仓库 Secrets，再运行 Sync Feishu and deploy Pages。');
    return decrypt(envelope,passphrase);
  }
  function taskSnapshot(value){
    const data=value?.taskSync;
    if(!Number.isFinite(Date.parse(data?.syncedAt))||!Array.isArray(data.items)||data.items.length>5000){
      throw Error('飞书任务快照格式无效。');
    }
    const ids=new Set();
    const items=data.items.map(task=>{
      if(!task||!/^[a-f0-9-]{36}$/.test(task.guid)||ids.has(task.guid)||typeof task.title!=='string'||
        typeof task.due!=='string'||(task.due&&!/^\d{4}-\d{2}-\d{2}$/.test(task.due))||
        (task.dueAt!==null&&(!Number.isFinite(task.dueAt)||Math.abs(task.dueAt)>8640000000000000))){
        throw Error('飞书任务数据不完整。');
      }
      ids.add(task.guid);
      return {id:'feishu-task:'+task.guid,guid:task.guid,title:task.title,due:task.due,dueAt:task.dueAt,done:false,source:'feishu-task'};
    });
    return {syncedAt:data.syncedAt,items};
  }
  async function fetchTasks(passphrase){
    const envelope=await fetchEnvelope('feishu-tasks.enc.json');
    return envelope?taskSnapshot(await decryptPayload(envelope,passphrase)):null;
  }
  root.KejianCalendar={snapshot,merge,decrypt,fetchSnapshot,fetchTasks,taskSnapshot};
})(typeof window==='undefined'?globalThis:window);
