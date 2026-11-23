const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'_site');
fs.mkdirSync(out,{recursive:true});
for(const name of ['index.html','workbench.html','calendar-sync.js','invoice-store.js','workbench-invoices.js','album.html','together.html','together.js','together.css','.nojekyll','css','img-one','mp3','cube-photos.json','playlist.json']){
  fs.cpSync(path.join(root,name),path.join(out,name),{recursive:true});
}
// Each deployment points first-party styles/scripts at the matching version.
const version=process.env.GITHUB_SHA||require('node:crypto').createHash('sha256').update(['workbench.html','calendar-sync.js','invoice-store.js','workbench-invoices.js','together.js','together.css'].map(n=>fs.readFileSync(path.join(root,n),'utf8')).join('')).digest('hex').slice(0,16);
for(const name of ['workbench.html','together.html']){
  const file=path.join(out,name);
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(/(src|href)="(calendar-sync\.js|invoice-store\.js|workbench-invoices\.js|together\.(?:js|css))"/g,(_,attr,asset)=>`${attr}="${asset}?v=${version}"`));
}
console.log('Packaged public pages and existing album assets.');
