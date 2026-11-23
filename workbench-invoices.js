(function(root){
  'use strict';

  function rememberDirectory(handle){
    return new Promise((resolve,reject)=>{
      if(!root.indexedDB){resolve(null);return;}
      const open=root.indexedDB.open('kejian-workbench-oil-folder',1);
      open.onupgradeneeded=()=>open.result.createObjectStore('directories');
      open.onerror=()=>reject(open.error);
      open.onsuccess=()=>{
        const db=open.result;
        const tx=db.transaction('directories',handle?'readwrite':'readonly');
        const store=tx.objectStore('directories');
        const operation=handle?store.put(handle,'root'):store.get('root');
        tx.oncomplete=()=>{db.close();resolve(operation.result||null);};
        tx.onabort=()=>{db.close();reject(tx.error);};
      };
    });
  }

  function mount(panel, app){
    const model=root.WorkbenchInvoiceStore;
    const find=selector=>panel.querySelector(selector);
    const list=find('#kk-invoices-list'), summary=find('#kk-invoices-summary');
    const status=find('#kk-invoices-status');
    const search=find('#kk-invoices-search'), sort=find('#kk-invoices-sort');
    const editor=find('#kk-invoice-editor'), form=find('#kk-invoice-form');
    const preview=find('#kk-invoice-preview'), previewBody=find('#kk-invoice-preview-body');
    const folderButton=find('#kk-invoices-folder-button'), refresh=find('#kk-invoices-refresh');
    const localLink=find('#kk-invoices-local-link');
    const canPick=typeof root.showDirectoryPicker==='function';
    if(app.localFolderFallback){
      localLink.href=app.localFolderFallback;
      localLink.hidden=false;
    }
    folderButton.disabled=!canPick;
    const text=app.escape;
    const compare=(a,b)=>String(a||'').localeCompare(String(b||''),'zh-CN',{numeric:true});
    let directory=null, database=null, loading=null, busy=false, records=[], previewUrl='', previewRequest=0;
    let editingId='';

    function current(){
      const query=search.value.trim().toLowerCase();
      return records.filter(r=>(status.value==='all'||r.status===status.value)&&
        (!query||[r.name,r.merchant,r.note,r.date,r.usedNote,r.usedDate].some(value=>String(value||'').toLowerCase().includes(query))))
        .sort((a,b)=>{
          if(sort.value==='amount')return (b.amount??-1)-(a.amount??-1)||compare(a.name,b.name);
          if(sort.value==='name')return compare(a.name,b.name);
          return compare(b.date,a.date)||compare(a.name,b.name);
        });
    }

    const statusLabel=r=>r.status==='used'?'已使用':'未使用';

    function render(){
      if(!database)return;
      const unused=records.filter(r=>r.status!=='used');
      const total=unused.reduce((sum,r)=>sum+Math.round((r.amount??0)*100),0)/100;
      const missing=unused.filter(r=>r.amount===null).length;
      summary.textContent=`未使用 ${unused.length} 张 · ${app.money(total)}${missing?` · ${missing} 张金额待填`:''} · 已使用 ${records.length-unused.length} 张`;
      const rows=current();
      list.innerHTML=rows.length?rows.map(r=>`<tr>
        <td class="kk-invoice-name" title="${text(r.relativePath||r.name)}">${text(r.name)}</td>
        <td>${text(r.merchant||'—')}</td><td class="num">${text(r.date||'—')}</td>
        <td class="num">${r.amount===null?'—':app.money(r.amount)}</td>
        <td><span class="kk-invoice-status ${r.status==='used'?'used':''}">${statusLabel(r)}</span>${r.usedDate?`<small class="kk-invoice-use-date">${text(r.usedDate)}</small>`:''}</td>
        <td class="kk-invoice-note">${text((r.status==='used'&&r.usedNote)||r.note||'—')}</td>
        <td><div class="kk-invoice-row-actions">
          ${r.hasFile?`<button type="button" class="btn sm" data-invoice-action="preview" data-id="${text(r.id)}">预览</button>`:''}
          <button type="button" class="btn sm" data-invoice-action="edit" data-id="${text(r.id)}">编辑</button>
          <button type="button" class="btn sm" data-invoice-action="toggle" data-id="${text(r.id)}">${r.status==='used'?'恢复未使用':'标记已使用'}</button>
        </div></td></tr>`).join(''):`<tr><td colspan="7"><div class="empty">${records.length?'当前筛选下没有油票。':'这两个目录里还没有油票。'}</div></td></tr>`;
      refresh.disabled=false;
      app.labelTable(find('#kk-invoices-table'));
      find('#kk-invoice-filenames').innerHTML=[...new Set(records.map(r=>r.name))]
        .sort(compare).map(name=>`<option value="${text(name)}"></option>`).join('');
    }

    async function reload(){
      records=await database.list();
      render();
    }

    async function attach(handle){
      const store=await model.connect(handle);
      const invoices=await store.list();
      directory=handle;
      database=store;
      records=invoices;
      render();
    }

    function load(){
      if(!model){
        summary.textContent='油票管理加载失败，请刷新页面。';
        return Promise.resolve();
      }
      if(!canPick){
        summary.textContent='请用电脑上的 Edge 或 Chrome 打开工作台，以连接油票文件夹。';
        return Promise.resolve();
      }
      if(!loading){
        loading=(async()=>{
          try{
            const saved=await rememberDirectory();
            if(busy||database)return;
            directory=saved;
            if(directory&&await directory.queryPermission({mode:'readwrite'})==='granted'){
              await attach(directory);
              return;
            }
          }catch{
            directory=null;
          }
          if(!database)summary.textContent='请连接原「发票」文件夹';
        })();
      }
      return loading;
    }

    function errorText(error){
      if(error?.name==='SecurityError')return '当前页面无法打开目录。请在电脑 Edge 或 Chrome 的独立标签页打开工作台。';
      if(error?.name==='NotAllowedError')return '请重新连接「发票」文件夹，并允许浏览器读写。';
      return error?.message||'油票操作失败，请重试。';
    }

    function showError(message){
      summary.textContent=message;
      app.toast(message);
    }

    async function mutate(operation){
      if(busy||!database)return;
      busy=true;
      panel.setAttribute('aria-busy','true');
      try{ await operation(); }
      catch(error){
        try{ await reload(); }catch{}
        showError(errorText(error));
      }
      finally{
        busy=false;
        panel.removeAttribute('aria-busy');
      }
    }

    folderButton.addEventListener('click',async()=>{
      if(!canPick||busy||!model)return;
      busy=true;
      panel.setAttribute('aria-busy','true');
      try{
        const options={id:'workbench-oil-invoices',mode:'readwrite'};
        if(directory)options.startIn=directory;
        const selected=await root.showDirectoryPicker(options);
        await attach(selected);
        try{ await rememberDirectory(selected); }catch{}
      }catch(error){
        if(error?.name!=='AbortError')showError(errorText(error));
      }finally{
        busy=false;
        panel.removeAttribute('aria-busy');
      }
    });
    refresh.addEventListener('click',()=>void mutate(reload));

    function showEditor(record){
      editingId=record.id;
      find('#kk-invoice-edit-name').textContent=record.name;
      form.elements.merchant.value=record.merchant;
      form.elements.date.value=record.date;
      form.elements.amount.value=record.amount??'';
      form.elements.note.value=record.note;
      form.elements.usedNote.value=record.usedNote;
      editor.showModal();
    }

    function clearPreview(){
      previewRequest++;
      if(previewUrl)URL.revokeObjectURL(previewUrl);
      previewUrl='';
      previewBody.replaceChildren();
      find('#kk-invoice-download').removeAttribute('href');
    }

    async function showPreview(record){
      const request=++previewRequest;
      try{
        const file=await database.file(record.id);
        if(request!==previewRequest)return;
        if(!file){app.toast('油票原文件已不在目录里，请刷新列表');return;}
        const extension=String(file.name||record.name).split('.').pop().toLowerCase();
        const types={pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',bmp:'image/bmp',heic:'image/heic',heif:'image/heif',avif:'image/avif'};
        const storedType=Object.entries(types).find(([,type])=>type===file.type);
        const mime=storedType?.[1]||types[extension]||'application/octet-stream';
        if(previewUrl)URL.revokeObjectURL(previewUrl);
        previewUrl=URL.createObjectURL(file.slice(0,file.size,mime));
        find('#kk-invoice-preview-name').textContent=record.name;
        const downloadLink=find('#kk-invoice-download');
        downloadLink.href=previewUrl;
        downloadLink.download=storedType&&types[extension]!==mime
          ?record.name.replace(/\.[^.]+$/,'')+'.'+storedType[0]:record.name;
        if(mime==='application/pdf'){
          const viewer=document.createElement('object');
          viewer.type=mime;
          viewer.data=previewUrl;
          viewer.textContent='当前浏览器无法预览 PDF，可以下载打开。';
          previewBody.replaceChildren(viewer);
        } else if(mime.startsWith('image/')){
          const viewer=document.createElement('img');
          viewer.alt=record.name;
          viewer.addEventListener('error',()=>{if(request===previewRequest)previewBody.textContent='当前浏览器无法预览此图片，可以下载打开。';},{once:true});
          viewer.src=previewUrl;
          previewBody.replaceChildren(viewer);
        } else {
          previewBody.textContent='当前浏览器无法预览此文件，可以下载打开。';
        }
        if(!preview.open)preview.showModal();
      }catch(error){app.toast('预览失败，请刷新列表或检查原文件');}
    }

    function safeCell(value){
      if(typeof value==='string'&&/^[\s\uFEFF]*[=+\-@]/.test(value))return "'"+value;
      return value;
    }

    for(const option of [sort,status])option.addEventListener('change',render);
    search.addEventListener('input',render);
    find('#kk-invoices-export').addEventListener('click',()=>{
      const rows=current();
      if(!rows.length){app.toast('当前没有可导出的发票');return;}
      const data=[['文件名','商户','开票日期','金额','备注','状态','使用日期','用途','所在目录'],
        ...rows.map(r=>[r.name,r.merchant,r.date,r.amount===null?'':r.amount.toFixed(2),r.note,statusLabel(r),r.usedDate,r.usedNote,r.relativePath].map(safeCell))];
      app.download(`油票台账_${app.today()}.csv`,'\ufeff'+app.csv(data),'text/csv;charset=utf-8');
      app.toast('发票 CSV 已导出');
    });
    list.addEventListener('click',event=>{
      const button=event.target.closest('[data-invoice-action]');
      if(!button||busy)return;
      const record=records.find(r=>r.id===button.dataset.id);
      if(!record)return;
      if(button.dataset.invoiceAction==='preview')void showPreview(record);
      if(button.dataset.invoiceAction==='edit')showEditor(record);
      if(button.dataset.invoiceAction==='toggle'){
        const used=record.status!=='used';
        void mutate(async()=>{
          const moved=await database.move(record.id,used,used?app.today():'');
          await reload();
          const destination=used?'03已使用 / 油票':'02油票';
          app.toast('已移到 '+destination+(moved?.name&&moved.name!==record.name?'，文件名为 '+moved.name:''));
        });
      }
    });
    form.addEventListener('submit',event=>{
      event.preventDefault();
      if(!form.reportValidity()||busy)return;
      const values=new FormData(form);
      const record=records.find(row=>row.id===editingId);
      if(!record)return;
      const amountText=String(values.get('amount')).trim();
      const amount=amountText===''?null:Number(amountText);
      if(amount!==null&&(!Number.isFinite(amount)||amount<0)){app.toast('请填写有效的发票金额');return;}
      void mutate(async()=>{
        const updated={...record,date:values.get('date'),
          merchant:String(values.get('merchant')).trim(),amount,note:String(values.get('note')).trim(),
          usedNote:String(values.get('usedNote')).trim()};
        await database.save(updated);
        await reload();
        editor.close();
        app.toast('发票信息已保存');
      });
    });
    find('#kk-invoice-editor-close').addEventListener('click',()=>editor.close());
    find('#kk-invoice-preview-close').addEventListener('click',()=>preview.close());
    preview.addEventListener('close',clearPreview);
    return { load };
  }

  root.WorkbenchInvoices={mount};
})(window);

