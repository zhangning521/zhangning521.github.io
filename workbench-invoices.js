(function(root){
  'use strict';

  function mount(panel, app){
    const model=root.WorkbenchInvoiceStore;
    const find=selector=>panel.querySelector(selector);
    const list=find('#kk-invoices-list'), summary=find('#kk-invoices-summary');
    const category=find('#kk-invoices-category'), status=find('#kk-invoices-status');
    const search=find('#kk-invoices-search'), sort=find('#kk-invoices-sort');
    const editor=find('#kk-invoice-editor'), form=find('#kk-invoice-form');
    const preview=find('#kk-invoice-preview'), previewBody=find('#kk-invoice-preview-body');
    const fileInput=find('#kk-invoices-files'), folderInput=find('#kk-invoices-folder');
    const folderButton=find('#kk-invoices-folder-button');
    const text=app.escape;
    const compare=(a,b)=>String(a||'').localeCompare(String(b||''),'zh-CN',{numeric:true});
    let database=null, loading=null, busy=false, records=[], previewUrl='', previewRequest=0;
    let editingId='';

    function current(){
      const query=search.value.trim().toLowerCase();
      return records.filter(r=>(category.value==='all'||r.cat===category.value)&&
        (status.value==='all'||r.status===status.value)&&
        (!query||[r.name,r.merchant,r.note,r.date,r.usedNote,r.usedDate].some(value=>String(value||'').toLowerCase().includes(query))))
        .sort((a,b)=>{
          if(sort.value==='amount')return (b.amount??-1)-(a.amount??-1)||compare(a.name,b.name);
          if(sort.value==='name')return compare(a.name,b.name);
          return compare(b.date,a.date)||compare(a.name,b.name);
        });
    }

    const label=r=>model.categories[r.cat]||'其他发票';
    const statusLabel=r=>r.status==='used'?'已使用':'未使用';

    function render(){
      if(!database)return;
      const unused=records.filter(r=>r.status!=='used');
      const total=unused.reduce((sum,r)=>sum+Math.round((r.amount??0)*100),0)/100;
      const missing=unused.filter(r=>r.amount===null).length;
      summary.textContent=`未使用 ${unused.length} 张 · ${app.money(total)}${missing?` · ${missing} 张金额待填`:''} · 已使用 ${records.length-unused.length} 张`;
      const rows=current();
      list.innerHTML=rows.length?rows.map(r=>`<tr>
        <td class="kk-invoice-name">${text(r.name)}</td><td>${text(label(r))}</td>
        <td>${text(r.merchant||'—')}</td><td class="num">${text(r.date||'—')}</td>
        <td class="num">${r.amount===null?'—':app.money(r.amount)}</td>
        <td><span class="kk-invoice-status ${r.status==='used'?'used':''}">${statusLabel(r)}</span>${r.usedDate?`<small class="kk-invoice-use-date">${text(r.usedDate)}</small>`:''}</td>
        <td class="kk-invoice-note">${text((r.status==='used'&&r.usedNote)||r.note||'—')}</td>
        <td><div class="kk-invoice-row-actions">
          ${r.hasFile?`<button type="button" class="btn sm" data-invoice-action="preview" data-id="${text(r.id)}">预览</button>`:''}
          <button type="button" class="btn sm" data-invoice-action="edit" data-id="${text(r.id)}">编辑</button>
          <button type="button" class="btn sm" data-invoice-action="toggle" data-id="${text(r.id)}">${r.status==='used'?'恢复未使用':'标记已使用'}</button>
        </div></td></tr>`).join(''):`<tr><td colspan="8"><div class="empty">${records.length?'当前筛选下没有发票。':'还没有发票，可以添加文件或导入旧发票文件夹。'}</div></td></tr>`;
      app.labelTable(find('#kk-invoices-table'));
      find('#kk-invoice-filenames').innerHTML=[...new Set(records.map(r=>r.name))]
        .sort(compare).map(name=>`<option value="${text(name)}"></option>`).join('');
    }

    async function reload(){
      records=await database.list();
      render();
    }

    function load(){
      if(!model){
        summary.textContent='发票管家加载失败，请刷新页面。';
        return Promise.resolve();
      }
      if(!loading){
        loading=(async()=>{
          database=await model.open();
          await reload();
        })().catch(()=>{
          summary.textContent='无法打开浏览器发票台账。请在允许网站保存数据的浏览器窗口中使用。';
          database=null;
          loading=null;
        });
      }
      return loading;
    }

    async function mutate(operation){
      if(busy)return;
      busy=true;
      panel.setAttribute('aria-busy','true');
      try {
        await load();
        if(!database){app.toast('无法打开浏览器发票台账');return;}
        await operation();
      } catch(error){
        app.toast(error?.message||'发票操作失败，请重试');
      } finally {
        busy=false;
        panel.removeAttribute('aria-busy');
      }
    }

    function importFiles(files){
      if(!files.length)return;
      void mutate(async()=>{
        const result=await database.importFiles(files,category.value==='all'?'other':category.value);
        const changed=result.added+result.updated;
        if(changed){
          status.value='all';
          category.value='all';
          search.value='';
          await reload();
        }
        app.toast(`新增 ${result.added} 张，补充 ${result.updated} 张${result.skipped?`，跳过 ${result.skipped} 个文件`:''}`);
      });
    }

    function showEditor(record){
      editingId=record.id;
      find('#kk-invoice-edit-name').textContent=record.name;
      form.elements.category.value=record.cat;
      form.elements.merchant.value=record.merchant;
      form.elements.date.value=record.date;
      form.elements.amount.value=record.amount??'';
      form.elements.note.value=record.note;
      form.elements.usedNote.value=record.usedNote;
      form.elements.attachment.value='';
      find('#kk-invoice-replace-label').textContent=record.hasFile?'替换附件（可选）':'补充附件（可选）';
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
        if(!file){app.toast('这条发票缺少附件，可在编辑中补充');return;}
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
      }catch(error){app.toast('预览失败，可以重新导入或补充该附件');}
    }

    function safeCell(value){
      if(typeof value==='string'&&/^[\s\uFEFF]*[=+\-@]/.test(value))return "'"+value;
      return value;
    }

    for(const option of [category,sort,status])option.addEventListener('change',render);
    search.addEventListener('input',render);
    find('#kk-invoices-add').addEventListener('click',()=>{if(!busy)fileInput.click();});
    folderButton.hidden=!('webkitdirectory' in folderInput);
    folderButton.addEventListener('click',()=>{if(!busy)folderInput.click();});
    for(const input of [fileInput,folderInput]){
      input.addEventListener('change',()=>{
        const files=Array.from(input.files||[]);
        input.value='';
        importFiles(files);
      });
    }
    panel.addEventListener('dragover',event=>{
      if(!event.dataTransfer?.types.includes('Files'))return;
      event.preventDefault();
      panel.classList.add('drag-target');
    });
    panel.addEventListener('dragleave',event=>{
      if(!panel.contains(event.relatedTarget))panel.classList.remove('drag-target');
    });
    panel.addEventListener('drop',event=>{
      if(!event.dataTransfer?.types.includes('Files'))return;
      event.preventDefault();
      panel.classList.remove('drag-target');
      importFiles(Array.from(event.dataTransfer.files));
    });
    find('#kk-invoices-export').addEventListener('click',()=>{
      const rows=current();
      if(!rows.length){app.toast('当前没有可导出的发票');return;}
      const data=[['类别','文件名','商户','开票日期','金额','备注','状态','使用日期','用途'],
        ...rows.map(r=>[label(r),r.name,r.merchant,r.date,r.amount===null?'':r.amount.toFixed(2),r.note,statusLabel(r),r.usedDate,r.usedNote].map(safeCell))];
      app.download(`发票台账_${app.today()}.csv`,'\ufeff'+app.csv(data),'text/csv;charset=utf-8');
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
          await database.save({...record,status:used?'used':'unused',usedDate:used?app.today():''});
          await reload();
          app.toast(used?'发票已标记为已使用':'发票已恢复为未使用');
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
      const extra=form.elements.attachment.files[0];
      void mutate(async()=>{
        const updated={...record,cat:values.get('category'),date:values.get('date'),
          merchant:String(values.get('merchant')).trim(),amount,note:String(values.get('note')).trim(),
          usedNote:String(values.get('usedNote')).trim()};
        await database.save(updated,extra);
        await reload();
        editor.close();
        app.toast('发票信息已保存');
      });
    });
    find('#kk-invoice-remove').addEventListener('click',()=>{
      const record=records.find(row=>row.id===editingId);
      if(!record||busy||!root.confirm('从工作台移除这张发票和附件副本？原文件仍保留在原来的文件夹。'))return;
      void mutate(async()=>{
        await database.remove(record.id);
        await reload();
        editor.close();
        app.toast('发票已移除');
      });
    });
    find('#kk-invoice-editor-close').addEventListener('click',()=>editor.close());
    find('#kk-invoice-preview-close').addEventListener('click',()=>preview.close());
    preview.addEventListener('close',clearPreview);
    return { load };
  }

  root.WorkbenchInvoices={mount};
})(window);

