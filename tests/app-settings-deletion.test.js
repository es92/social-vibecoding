const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('frontend/src/features/dialogs/app-settings.tsx', 'utf8');
// Exercise the component's actual async handlers without needing the optional
// frontend install in the server test image. Only parameter types are erased.
function handler(name) {
  const start = source.indexOf(`  async function ${name}(`);
  const end = source.indexOf('\n  }', start) + 4;
  return source.slice(start, end).replace(': FormEvent', '').replace(': string', '');
}
function setup(fetch) {
  const s = { app: {slug:'test-app',name:'Test App',repo_url:'https://github.com/o/r',self_hosted:false,
    can_manage:true,collab_visibility:'public',view_visibility:'public',can_delete:true,contributor_count:1},
    confirmation:'Test App',accessDraft:'private',accessChanged:true,accessProposalOpen:false,
    sharedAck:false,setSharedAck(v){s.sharedAck=v;},JSON,
    pending:{current:false},generation:{current:0},fetch,Error,Promise,
    setApp(v){s.app=v;},setConfirmation(v){s.confirmation=v;},setError(v){s.error=v;},
    setLoading(v){s.loading=v;},setBusy(v){s.busy=v;},
    setAccessDraft(v){s.accessDraft=v;},setAccessMessage(v){s.accessMessage=v;},
    setAccessMessageIsError(v){s.accessMessageIsError=v;},setAccessBusy(v){s.accessBusy=v;},
    setAccessProposalOpen(v){s.accessProposalOpen=v;},
    currentAccessMode(app){return app.collab_visibility==='public'?'public':(app.view_visibility==='private'?'private':'public-invite');},
    visibilityForAccess(mode){return ACCESS_MODES.find((item)=>item.id===mode);},
    dialog:{close(){s.closed=true;s.order.push('close');},
      closeForNavigation(){s.closed=true;s.order.push('closeForNavigation');}},
    window:{App:{navigateHome(){s.home=true;s.order.push('navigateHome');}},Home:{load(){}},PlatformUI:{toast(){}}},
    order:[],
  };
  vm.createContext(s); vm.runInContext(`${handler('load')}\n${handler('proposeAccess')}\n${handler('remove')}`,s);
  s.submit=()=>s.remove({preventDefault(){}}); return s;
}
const ok = (app) => ({ok:true,json:async()=>({app})});
const deferred = () => {let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

const modesSource = source.match(/const ACCESS_MODES:[\s\S]*?= (\[[\s\S]*?\n\]);\n\nfunction currentAccessMode/);
assert.ok(modesSource, 'access mode table is readable');
const ACCESS_MODES = vm.runInNewContext(`(${modesSource[1]})`);

test('the three access modes map only to the valid build/view combinations',()=>{
  const values=Object.fromEntries(ACCESS_MODES.map((mode)=>[mode.id,[mode.collabVisibility,mode.viewVisibility]]));
  assert.deepEqual(values,{
    public:['public','public'],
    'public-invite':['private','public'],
    private:['private','private'],
  });
});

test('an explicit access proposal sends the selected valid combination',async()=>{
  let path;let sent;
  const s=setup(async(p,opts)=>{path=p;sent=opts;return {ok:true,status:201,json:async()=>({prNumber:77})};});
  s.accessDraft='public-invite';
  await s.proposeAccess();
  assert.equal(path,'/api/apps/test-app/visibility-pr');
  assert.equal(sent.method,'POST');
  assert.deepEqual(JSON.parse(sent.body),{collabVisibility:'private',viewVisibility:'public'});
  assert.equal(s.accessProposalOpen,true);
  assert.match(s.accessMessage,/PR #77/);
});

test('access proposals stay blocked without management, a repo, or a mutable app',async()=>{
  let calls=0;const s=setup(async()=>{calls++;return ok();});
  s.app.can_manage=false;await s.proposeAccess();
  s.app.can_manage=true;s.app.repo_url=null;await s.proposeAccess();
  s.app.repo_url='https://github.com/o/r';s.app.self_hosted=true;await s.proposeAccess();
  s.app.self_hosted=false;s.accessChanged=false;await s.proposeAccess();
  assert.equal(calls,0);
});

test('an existing visibility proposal is reported and prevents a duplicate retry',async()=>{
  let calls=0;const s=setup(async()=>{calls++;return {ok:false,status:409,json:async()=>({sessionId:55})};});
  await s.proposeAccess();
  assert.equal(s.accessProposalOpen,true);
  assert.match(s.accessMessage,/already waiting for approval/);
  await s.proposeAccess();
  assert.equal(calls,1);
});

test('deletion requires current permission and the exact app name',async()=>{
  let calls=0;const s=setup(async()=>{calls++;return ok();});
  s.confirmation='test app';await s.submit();assert.equal(calls,0);
  s.confirmation='Test App';s.app.can_delete=false;await s.submit();assert.equal(calls,0);
  s.app.can_delete=true;await s.submit();assert.equal(calls,1);assert.ok(s.closed&&s.home);
});
test('the request carries the typed name so the server can verify it (#2161)',async()=>{
  let sent;const s=setup(async(path,opts)=>{sent=opts;return ok();});
  await s.submit();assert.equal(sent.method,'DELETE');
  assert.equal(sent.headers['Content-Type'],'application/json');
  assert.deepEqual(JSON.parse(sent.body),{confirm_name:'Test App',acknowledge_shared:false});
});
test('a shared app needs the acknowledgement as well as the name, and sends it (#2161)',async()=>{
  let sent=null;const s=setup(async(path,opts)=>{sent=opts;return ok();});
  s.app.contributor_count=3;
  await s.submit();assert.equal(sent,null,'name alone does not arm a shared delete');
  assert.equal(s.closed,undefined);
  s.sharedAck=true;await s.submit();
  assert.deepEqual(JSON.parse(sent.body),{confirm_name:'Test App',acknowledge_shared:true});
  assert.ok(s.closed&&s.home);
});
test('a blocked app (core or shared) never makes a request',async()=>{
  let calls=0;const s=setup(async()=>{calls++;return ok();});
  s.app={slug:'usernode-2d5619',name:'Homeroom',can_delete:false,delete_block:'core',contributor_count:30};
  s.confirmation='Homeroom';s.sharedAck=true;await s.submit();assert.equal(calls,0);
  s.app={slug:'test-app',name:'Test App',can_delete:false,delete_block:'shared',contributor_count:2};
  s.confirmation='Test App';await s.submit();assert.equal(calls,0);
});
test('the blocked notice names the reason the server gave (#2161)',()=>{
  const start=source.indexOf('function blockedCopy(');const end=source.indexOf('\n}',start)+2;
  const ctx={};vm.createContext(ctx);vm.runInContext(source.slice(start,end).replace(': AppSettings',''),ctx);
  assert.match(ctx.blockedCopy({delete_block:'core'}),/core platform app/);
  assert.match(ctx.blockedCopy({delete_block:'shared',contributor_count:2}),/1 other contributor,/);
  assert.match(ctx.blockedCopy({delete_block:'shared',contributor_count:4}),/3 other contributors,/);
  assert.match(ctx.blockedCopy({delete_block:'not_owner'}),/do not have permission/);
  assert.match(ctx.blockedCopy({}),/do not have permission/);
  for(const copy of [ctx.blockedCopy({delete_block:'core'}),ctx.blockedCopy({delete_block:'shared',contributor_count:2})]){
    assert.ok(!/\u2014|\u2013/.test(copy),'no dashes in user-facing copy');
  }
  assert.match(source,/id="app-delete-blocked"/,'the notice is the declared check\u2019s anchor');
  assert.match(source,/id="app-delete-shared-ack"/,'the admin acknowledgement is a real checkbox');
});
test('a deletion closes as a navigating close before it goes Home (#3683)',async()=>{
  // A plain close spends the dialog's back-button record with a queued
  // history.back(), which lands after Home's address and puts the viewer back
  // on the page of the app they just deleted.
  const s=setup(async()=>ok());
  await s.submit();
  assert.deepEqual(s.order,['closeForNavigation','navigateHome']);
});
test('double submission makes one DELETE and waits before navigation',async()=>{
  const request=deferred();let calls=0;const s=setup(async(path,opts)=>{assert.equal(path,'/api/apps/test-app');assert.equal(opts.method,'DELETE');calls++;return request.promise;});
  const first=s.submit();await s.submit();assert.equal(calls,1);assert.equal(s.closed,undefined);
  request.resolve(ok());await first;assert.ok(s.closed);assert.equal(s.busy,false);
});
test('server denial and network failure stay open and can be retried',async()=>{
  let attempts=0;const s=setup(async()=>{if(++attempts===1)return {ok:false,json:async()=>({error:'Permission changed'})};if(attempts===2)throw new Error('Offline');return ok();});
  await s.submit();assert.equal(s.error,'Permission changed');assert.equal(s.closed,undefined);
  await s.submit();assert.equal(s.error,'Offline');assert.equal(s.pending.current,false);
  await s.submit();assert.ok(s.closed);
});
test('settings reload clears confirmation and uses fresh server permissions',async()=>{
  const s=setup(async()=>ok({slug:'test-app',name:'New name',can_delete:false}));
  s.sharedAck=true;
  await s.load('test-app');assert.equal(s.confirmation,'');assert.equal(s.app.can_delete,false);
  assert.equal(s.sharedAck,false,'the acknowledgement does not survive a reload');
  assert.equal(s.app.name,'New name');assert.equal(s.loading,false);
});
test('late settings responses cannot overwrite a new app or a closed dialog',async()=>{
  const first=deferred();const s=setup(async(path)=>path.endsWith('first')?first.promise:ok({slug:'second',can_delete:false}));
  const old=s.load('first');await s.load('second');first.resolve(ok({slug:'first',can_delete:true}));await old;assert.equal(s.app.slug,'second');
  const late=deferred();s.fetch=()=>late.promise;const closing=s.load('closed');s.generation.current++;
  late.resolve(ok({slug:'closed',can_delete:true}));await closing;assert.equal(s.app,null);
});
test('settings load errors are visible and retryable',async()=>{
  let fail=true;const s=setup(async()=>{if(fail)throw new Error('Offline');return ok({slug:'test-app',can_delete:true});});
  await s.load('test-app');assert.equal(s.error,'Offline');assert.equal(s.loading,false);
  fail=false;await s.load('test-app');assert.equal(s.error,'');assert.equal(s.app.can_delete,true);
});
