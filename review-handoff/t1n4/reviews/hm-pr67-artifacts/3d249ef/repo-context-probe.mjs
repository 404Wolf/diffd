
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
const app=process.argv[2];
const model=await import(pathToFileURL(path.join(app,'mods/worktree-extras/model.js')));
const source=stripTypeScriptTypes(fs.readFileSync(path.join(app,'mods/worktree-extras/main.ts'),'utf8')).replace(/^import .*;\n/gm,'').replace('export default class WorktreeExtras','class WorktreeExtras');
const root=mkdtempSync('/var/tmp/hm-pr67-context-');
for(const n of ['repo-a','repo-b','not-git'])fs.mkdirSync(path.join(root,n));
for(const n of ['repo-a','repo-b'])execFileSync('git',['-C',path.join(root,n),'init','-q']);
const host={shared:{},overlays:[],calls:[],first:path.join(root,'repo-b')};
const {WorktreeExtras}=runInNewContext(source+'\n;({WorktreeExtras});',{
 ...model,View:class{},spaces:()=>[{id:'s',name:'repo-a',folder:path.join(root,'repo-a'),machine:null,tabs:[{id:'first'},{id:'focused'}]}],
 panes:()=>[{tab:'first',cwd:host.first},{tab:'focused',cwd:path.join(root,'repo-a')}],
 focused:()=>({space:'s',cwd:path.join(root,'repo-a')}),
 shared:k=>host.shared[k],setShared:(k,v)=>{host.shared[k]=v;},
 exec:async(cmd,args,opts)=>{host.calls.push({cmd,args:args.slice(-1),opts});const r=spawnSync(cmd,args,{encoding:'utf8'});return{code:r.status,stdout:r.stdout,stderr:r.stderr};},
 openOverlay:o=>host.overlays.push(o),layout:()=>({id:'root',children:[]})
});
await new WorktreeExtras().ask(1);
const otherRepo={spaceFolder:path.join(root,'repo-a'),focusedCwd:path.join(root,'repo-a'),firstPaneCwd:host.first,prompt:host.overlays[0]?.props?.ask};
host.first=path.join(root,'not-git');host.overlays=[];host.shared={};
await new WorktreeExtras().ask(2);
const outsideRepo={spaceFolder:path.join(root,'repo-a'),focusedCwd:path.join(root,'repo-a'),firstPaneCwd:host.first,prompt:host.overlays[0]?.props?.ask??null,state:host.shared['worktree.new']};
console.log(JSON.stringify({otherRepo,outsideRepo},null,2));
