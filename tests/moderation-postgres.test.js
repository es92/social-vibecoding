'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');
const express = require('express');
const moderation = require('../src/services/moderation');
const { importLegacyReports } = require('../src/services/moderation-migration');
const { moderationRoutes } = require('../src/routes/moderation');
const appAccess = require('../src/services/app-access');
const { moderationGuard, participationWrite } = require('../src/middleware/moderation');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('moderation enforces scope, retains evidence, serializes decisions and reverses restrictions (PostgreSQL)', async t => {
  const root = new Client({ connectionString:DSN, connectionTimeoutMillis:2000 });
  try { await root.connect(); } catch (err) { await root.end().catch(()=>{}); return t.skip(`Local test database unavailable: ${err.code}`); }
  const name = `moderation_test_${process.pid}`;
  const connectionsClosed = [];
  let pool, server;
  try {
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = '/'+name;
    pool = new Pool({ connectionString:url.toString(), max:10 });
    pool.on('connect', client => connectionsClosed.push(new Promise(resolve => client.once('end',resolve))));
    await pool.query(fs.readFileSync(path.join(__dirname,'../src/db/schema.sql'),'utf8'));
    const addUser = async (username, admin=false, published=false) => (await pool.query(`INSERT INTO users (username,password,is_admin,profile_published) VALUES ($1,'unused-test-password',$2,$3) RETURNING id,username`, [username,admin,published])).rows[0];
    const alice = await addUser('reporter'), bob = await addUser('author',false,true), outsider = await addUser('outsider'), admin = { ...await addUser('moderator',true),isAdmin:true,canAdminWrite:true };
    const admin2 = { ...await addUser('moderator2',true),isAdmin:true,canAdminWrite:true };
    const app = (await pool.query(`INSERT INTO apps (name,slug,created_by,view_visibility) VALUES ('Reported app','reported-app',$1,'public') RETURNING id`,[bob.id])).rows[0];
    const conv = (await pool.query("INSERT INTO conversations (kind,title,created_by) VALUES ('group','Private test room',$1) RETURNING id",[bob.id])).rows[0];
    await pool.query("INSERT INTO conversation_members (conversation_id,user_id,status) VALUES ($1,$2,'member'),($1,$3,'member')",[conv.id,alice.id,bob.id]);
    const msg = (await pool.query("INSERT INTO conversation_messages (conversation_id,sender_id,content) VALUES ($1,$2,'Original private evidence') RETURNING id",[conv.id,bob.id])).rows[0];
    await pool.query(`INSERT INTO conversation_message_attachments (id,conversation_id,message_id,user_id,kind,filename,content_type,size_bytes,data) VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',$1,$2,$3,'text','proof.txt','text/plain',5,$4)`,[conv.id,msg.id,bob.id,Buffer.from('proof')]);
    const input = { targetType:'conversation_message',target:msg.id,reason:'harassment',detail:'Please review' };
    // #5072: every newly inserted report row mails the compliance inbox,
    // through a spy here (the stub stands in for the mailer, the real
    // transaction runs). Refused reports mail nothing.
    const mailCalls = [];
    const mailOpts = { config: { complianceEmail: 'compliance@example.test' },
      sendMail: (cfg, mail) => { mailCalls.push({ cfg, ...mail }); } };
    await assert.rejects(moderation.submitReport(pool,null,input,mailOpts),{status:401});
    await assert.rejects(moderation.submitReport(pool,outsider,input,mailOpts),{status:404});
    await assert.rejects(moderation.submitReport(pool,bob,input,mailOpts),{status:404});
    await assert.rejects(moderation.submitReport(pool,alice,{...input,reason:'other',detail:''},mailOpts),{status:400});
    await assert.rejects(moderation.submitReport(pool,alice,{...input,detail:'x'.repeat(1001)},mailOpts),{status:400});
    assert.equal(mailCalls.length,0,'no mail for a refused report');
    const reports = await Promise.all([moderation.submitReport(pool,alice,input,mailOpts),moderation.submitReport(pool,alice,input,mailOpts)]);
    assert.equal(reports[0].id,reports[1].id,'concurrent retries produce one receipt');
    assert.equal(reports.filter(r=>r.duplicate).length,1);
    assert.equal(mailCalls.length,1,'one mail for one inserted report, none for the duplicate');
    assert.equal(mailCalls[0].cfg.complianceEmail,'compliance@example.test');
    assert.equal(mailCalls[0].kind,'content_report');
    assert.equal(mailCalls[0].to,'compliance@example.test');
    assert.equal(mailCalls[0].detail,'Please review');
    assert.ok(mailCalls[0].url.endsWith(`/#admin/reports/${mailCalls[0].caseId}`),'the mail links the case in the admin console');
    assert.equal(reports.some(r=>r.mailPayload),false,'the mail payload never reaches the client receipt');
    assert.ok(reports.every(r=>r.blockUserId===bob.id && r.blockUsername===bob.username),'message receipts identify the author for optional blocking');
    let c = (await pool.query("SELECT * FROM moderation_cases WHERE target_type = 'conversation_message'")).rows[0];
    const act = async (action, extra={}) => {
      c = (await pool.query('SELECT * FROM moderation_cases WHERE id = $1',[c.id])).rows[0];
      return moderation.moderate(pool,admin,c.id,{action,reason:'Policy violation reviewed by a moderator',revision:c.revision,...extra});
    };
    await assert.rejects(moderation.moderate(pool,{...admin,canAdminWrite:false},c.id,{action:'hide_message',reason:'x',revision:1}),{status:403});
    await assert.rejects(moderation.moderate(pool,admin,c.id,{action:'hide_message',reason:'',revision:1}),{status:400});
    await pool.query("UPDATE conversation_messages SET content = 'Edited after report' WHERE id = $1",[msg.id]);
    assert.equal((await pool.query('SELECT evidence FROM moderation_reports WHERE id = $1',[reports[0].id])).rows[0].evidence.content,'Original private evidence');
    await pool.query("INSERT INTO notifications (user_id,kind,conversation_message_id) VALUES ($1,'conversation_message',$2)",[alice.id,msg.id]);
    const races = await Promise.allSettled([act('hide_message'),act('hide_message')]);
    assert.equal(races.filter(r=>r.status==='fulfilled').length,1, JSON.stringify(races.map(r=>r.reason?.message)));
    assert.equal(races.find(r=>r.status==='rejected').reason.status,409);
    assert.equal((await pool.query('SELECT content FROM conversation_messages WHERE id = $1',[msg.id])).rows[0].content,moderation.REMOVED);
    assert.equal((await pool.query('SELECT id FROM notifications WHERE conversation_message_id = $1',[msg.id])).rowCount,0);
    await act('restore_message');
    assert.equal((await pool.query('SELECT content FROM conversation_messages WHERE id = $1',[msg.id])).rows[0].content,'Edited after report');
    await act('hide_message');
    await act('resolve');
    assert.ok((await pool.query('SELECT moderation_hidden_at FROM conversation_messages WHERE id = $1',[msg.id])).rows[0].moderation_hidden_at,'closing does not reverse action');
    await assert.rejects(act('resolve'),{status:409});
    await act('restore_message');
    const newReport = await moderation.submitReport(pool,alice,input,mailOpts);
    assert.notEqual(newReport.id,reports[0].id,'new report after closure opens another review cycle');
    assert.equal(mailCalls.length,2,'a report that reopens a case is a new row and mails again');
    c = (await pool.query('SELECT * FROM moderation_cases WHERE id = $1',[c.id])).rows[0];
    assert.equal(c.status,'new'); assert.equal(c.cycle,2);

    // Exercise the HTTP privacy boundary with real SQL, not a permissive mock.
    const web = express(); web.use(express.json());
    const identities = { alice, bob, outsider, admin, admin2, readonly:{...admin,canAdminWrite:false} };
    web.use((req,res,next)=>{req.user=identities[req.get('x-test-user')];next();});
    web.use(moderationGuard({}, {pool}));
    web.use(moderationRoutes({}, {pool}));
    const poolModule = require('../src/db/pool');
    const previousGetPool = poolModule.getPool; poolModule.getPool = () => pool;
    web.use(require('../src/routes/conversations').conversationRoutes({}));
    web.use(require('../src/routes/chat').chatRoutes({}));
    poolModule.getPool = previousGetPool;
    web.post('/api/apps', (req,res)=>res.json({ok:true}));
    server = await new Promise(resolve=>{const s=web.listen(0,'127.0.0.1',()=>resolve(s));});
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (route,who='admin',init={}) => fetch(base+route,{...init,headers:{'x-test-user':who,'Content-Type':'application/json',...init.headers}});
    assert.equal((await get('/api/admin/moderation','alice')).status,404);
    assert.equal((await get(`/api/admin/moderation/${c.id}`,'readonly')).status,200);
    assert.equal((await get(`/api/admin/moderation/${c.id}/actions`,'readonly',{method:'POST',body:JSON.stringify({action:'hide_message',reason:'reason',revision:c.revision})})).status,403);
    assert.equal((await get('/api/admin/moderation?since=2026-02-30')).status,400);
    let detail = await (await get(`/api/admin/moderation/${c.id}`)).json();
    assert.equal(detail.reports.length,2); assert.ok(detail.actions.length>=5);
    const fileId = detail.files[0].id;
    const file = await get(`/api/admin/moderation/${c.id}/files/${fileId}`);
    assert.equal(await file.text(),'proof'); assert.match(file.headers.get('content-disposition'),/^attachment/); assert.match(file.headers.get('cache-control'),/no-store/);
    assert.equal((await get(`/api/admin/moderation/${c.id}/files/${fileId}`,'alice')).status,404);
    assert.equal((await get(`/api/admin/moderation/9999/files/${fileId}`)).status,404);

    const attachmentPath = `/api/conversations/${conv.id}/attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    assert.equal((await get(attachmentPath,'alice')).status,200);
    await act('hide_message');
    assert.equal((await get(attachmentPath,'alice')).status,404);
    assert.equal((await get(attachmentPath,'bob')).status,404,'authors cannot retrieve hidden attachments');
    const messages = await (await get(`/api/conversations/${conv.id}/messages`,'alice')).json();
    assert.equal(messages.messages[0].content,moderation.REMOVED);
    assert.deepEqual(messages.messages[0].attachments,[]);
    assert.equal(await require('../src/services/conversations').editMessage(pool,bob,conv.id,msg.id,'Evade moderation'),null);
    await act('restore_message');
    assert.equal((await get(attachmentPath,'alice')).status,200);
    // A deleted target keeps immutable evidence but cannot be moderated again.
    await pool.query('DELETE FROM conversation_messages WHERE id = $1',[msg.id]);
    await assert.rejects(act('hide_message'),{status:404});
    assert.equal(await (await get(`/api/admin/moderation/${c.id}/files/${fileId}`)).text(),'proof');
    detail = await (await get(`/api/admin/moderation/${c.id}`)).json(); assert.equal(detail.target,null);
    await act('resolve');
    await pool.query("UPDATE moderation_cases SET closed_at = NOW() - INTERVAL '181 days' WHERE id = $1",[c.id]);
    await moderation.purgeExpired(pool);
    assert.equal((await pool.query('SELECT evidence FROM moderation_reports WHERE case_id = $1',[c.id])).rows[0].evidence,null);
    assert.equal((await get(`/api/admin/moderation/${c.id}/files/${fileId}`)).status,404);

    const appReceipt = await moderation.submitReport(pool,alice,{targetType:'app',target:'reported-app',reason:'scam'},mailOpts);
    assert.equal(appReceipt.blockUserId,null,'reporting an app does not offer to block its creator');
    const duplicateAppReceipt = await moderation.submitReport(pool,alice,{targetType:'app',target:'reported-app',reason:'scam'},mailOpts);
    assert.equal(duplicateAppReceipt.id,appReceipt.id);
    assert.equal(mailCalls.length,3,'the app report mailed once, its duplicate did not');
    // A mail failure is logged, never surfaced: the receipt still comes back.
    // A fresh target, because this conversation's message was deleted above.
    const failApp = (await pool.query(`INSERT INTO apps (name,slug,created_by,view_visibility) VALUES ('Mail failure app','mail-failure-app',$1,'public') RETURNING id`,[bob.id])).rows[0];
    const failing = await moderation.submitReport(pool,alice,{targetType:'app',target:'mail-failure-app',reason:'spam'},{ config: { complianceEmail: 'compliance@example.test' }, sendMail: () => { throw new Error('provider down'); } });
    assert.equal(failing.received,true,'a mail failure does not fail the report');
    assert.equal(duplicateAppReceipt.blockUserId,null,'duplicate app reports use the same receipt contract');
    c=(await pool.query("SELECT * FROM moderation_cases WHERE target_type = 'app'")).rows[0];
    detail = await (await get(`/api/admin/moderation/${c.id}`)).json();
    assert.equal(detail.actionTaken,false);
    await act('note');
    assert.equal((await moderation.reviewState(pool,c)).actionTaken,false,'an internal note is not a moderation action');
    await assert.rejects(act('resolve'),{status:409},'a case without action must be dismissed');
    await act('suspend_app');
    await assert.rejects(act('dismiss'),{status:409},'a case with action must be resolved');
    await assert.rejects(act('suspend_app'),{status:409},'a completed action cannot be repeated');
    await pool.query("INSERT INTO moderation_actions (case_id,actor_id,action,reason) SELECT $1,$2,'note','Later note' FROM generate_series(1,51)",[c.id,admin.id]);
    detail = await (await get(`/api/admin/moderation/${c.id}`)).json();
    assert.equal(detail.actionTaken,true,'the decision does not depend on the first page of history');
    assert.ok(detail.actionsNext);
    assert.ok(detail.actions.every(a=>a.action==='note'));
    assert.ok(detail.target.moderation_suspended_at);
    assert.equal(detail.case.status,'in_review','taking action starts review without a separate button');
    assert.equal(await appAccess.getAppForUser(pool,'reported-app',bob),null,'owner has no suspension bypass');
    assert.equal(await appAccess.getAppForUser(pool,'reported-app',admin),null,'admin has no ordinary app access bypass');
    assert.equal((await get('/api/apps/reported-app/messages','alice')).status,403);
    await act('restore_app'); assert.ok(await appAccess.getAppForUser(pool,'reported-app',alice));
    assert.equal((await moderation.reviewState(pool,c)).actionTaken,true,'restoration does not erase the action taken');

    const userReceipt = await moderation.submitReport(pool,alice,{targetType:'user',target:'author',reason:'harassment'});
    assert.equal(userReceipt.blockUserId,bob.id,'user reports still offer the separately chosen block action');
    assert.equal(userReceipt.blockUsername,bob.username);
    c=(await pool.query("SELECT * FROM moderation_cases WHERE target_type = 'user' AND target_id = $1",[bob.id])).rows[0];
    const beforeSuspension=(await pool.query('SELECT id FROM moderation_actions WHERE case_id=$1',[c.id])).rowCount;
    const suspendInput={action:'suspend_user',reason:'Reviewed account suspension',revision:c.revision};
    assert.equal((await get(`/api/admin/moderation/${c.id}/actions`,'readonly',{method:'POST',body:JSON.stringify(suspendInput)})).status,403);
    assert.equal((await get(`/api/admin/moderation/${c.id}/actions`,'admin',{method:'POST',body:JSON.stringify(suspendInput)})).status,200);
    detail=await (await get(`/api/admin/moderation/${c.id}`)).json();
    assert.equal(detail.actionTaken,true);
    assert.ok(detail.target.profile_disabled_at,'Suspend user hides the profile');
    assert.ok(detail.target.participation_restricted_at,'Suspend user restricts participation in the same transaction');
    assert.equal((await pool.query('SELECT id FROM moderation_actions WHERE case_id=$1',[c.id])).rowCount,beforeSuspension+1,'one action and audit record');
    await assert.rejects(act('suspend_user'),{status:409});
    await assert.rejects(act('dismiss'),{status:409});
    assert.ok(await moderation.isRestricted(pool,bob.id));
    for (const route of ['/api/apps','/API/APPS',`/api/conversations/${conv.id}/messages`]) assert.equal((await get(route,'bob',{method:'POST',body:JSON.stringify({content:'bypass'})})).status,403,route);
    assert.equal((await get(`/api/conversations/${conv.id}/messages`,'bob')).status,200,'history stays accessible');
    await act('restore_profile'); await act('restore_user');
    assert.equal(await moderation.isRestricted(pool,bob.id),false);
    await act('hide_profile');
    await act('suspend_user');
    assert.ok(await moderation.isRestricted(pool,bob.id),'suspension also completes a previously partially moderated account');
    await act('restore_profile'); await act('restore_user');
    assert.equal((await pool.query('SELECT profile_disabled_reason FROM users WHERE id = $1',[bob.id])).rows[0].profile_disabled_reason,null);
    assert.ok((await pool.query("SELECT detail FROM notifications WHERE user_id = $1 AND kind = 'moderation_action'",[bob.id])).rows.every(r=>!r.detail.includes('reporter')));

    // App discussions use the same evidence and restoration contract.
    const chat = (await pool.query("INSERT INTO chat_messages (app_id,user_id,content,metadata) VALUES ($1,$2,'Public evidence','{\"attachments\": []}') RETURNING id",[app.id,bob.id])).rows[0];
    await moderation.submitReport(pool,alice,{targetType:'app_message',target:chat.id,reason:'spam'});
    const userCaseId=c.id;
    c=(await pool.query("SELECT * FROM moderation_cases WHERE target_type='app_message' AND target_id=$1",[chat.id])).rows[0];
    await act('hide_message');
    const hidden=(await pool.query('SELECT content,metadata FROM chat_messages WHERE id=$1',[chat.id])).rows[0];
    assert.deepEqual(hidden,{content:moderation.REMOVED,metadata:{}});
    await act('restore_message');
    assert.equal((await pool.query('SELECT content FROM chat_messages WHERE id=$1',[chat.id])).rows[0].content,'Public evidence');
    c=(await pool.query('SELECT * FROM moderation_cases WHERE id=$1',[userCaseId])).rows[0];
    // Non-public usernames require a real interaction; guessing a name is insufficient.
    await assert.rejects(moderation.submitReport(pool,alice,{targetType:'user',target:'outsider',reason:'spam'}),{status:404});
    await pool.query('UPDATE users SET profile_published = FALSE WHERE id = $1',[bob.id]);
    await act('resolve');
    assert.ok((await moderation.submitReport(pool,alice,{targetType:'user',target:'author',reason:'spam'})).received);

    await pool.query(`INSERT INTO moderation_cases (target_type,target_id,target_label,target_user_id) VALUES ('user',$1::integer,'Moderator',$1::integer),('user',$2::integer,'Moderator2',$2::integer)`,[admin.id,admin2.id]);
    const ca=(await pool.query("SELECT * FROM moderation_cases WHERE target_type = 'user' AND target_id=$1",[admin.id])).rows[0];
    const cb=(await pool.query("SELECT * FROM moderation_cases WHERE target_type = 'user' AND target_id=$1",[admin2.id])).rows[0];
    await assert.rejects(moderation.moderate(pool,admin,ca.id,{action:'suspend_user',reason:'test',revision:1}),{status:409});
    await moderation.moderate(pool,admin,cb.id,{action:'suspend_user',reason:'test',revision:1});
    await assert.rejects(moderation.moderate(pool,admin2,ca.id,{action:'suspend_user',reason:'test',revision:1}),{status:409});
    const protectedAdmin=(await pool.query('SELECT profile_disabled_at,participation_restricted_at FROM users WHERE id=$1',[admin.id])).rows[0];
    assert.equal(protectedAdmin.profile_disabled_at,null,'rejected suspension does not partly hide the profile');
    assert.equal(protectedAdmin.participation_restricted_at,null);

    // Legacy reports migrate once; original snapshots, timestamps and decisions survive.
    await pool.query("INSERT INTO profile_reports (profile_user_id,reporter_user_id,reason,detail) VALUES ($1,$2,'spam','Legacy report')",[outsider.id,bob.id]);
    await importLegacyReports(pool); await importLegacyReports(pool);
    assert.equal((await pool.query("SELECT id FROM moderation_reports WHERE legacy_type = 'profile'")).rowCount,1);
    const legacy = (await pool.query("SELECT * FROM moderation_cases WHERE target_type='user' AND target_id=$1",[outsider.id])).rows[0];
    await moderation.moderate(pool,admin,legacy.id,{action:'dismiss',reason:'Reviewed',revision:legacy.revision});
    assert.equal((await pool.query('SELECT status FROM profile_reports')).rows[0].status,'dismissed');

    // #2895 queues and endpoints feed the same cases, including orphaned evidence.
    await pool.query(`INSERT INTO app_reports (app_id,reporter_user_id,app_slug_snapshot,app_name_snapshot,reason,detail)
      VALUES ($1,$2,'reported-app','Original app name','unsafe_content','Legacy app report'),(NULL,$2,'gone-app','Deleted app','spam','Retain this')`,[app.id,admin2.id]);
    await pool.query(`INSERT INTO chat_message_reports (app_id,message_id,reporter_user_id,reported_user_id,app_slug_snapshot,reason,content_snapshot,evidence_snapshot)
      VALUES ($1,$2,$3,$4,'reported-app','spam','Original legacy post','{"threadType":"issue","threadRef":2721}'),(NULL,NULL,$3,NULL,'gone-app','spam','Deleted legacy post','{}')`,[app.id,chat.id,admin2.id,bob.id]);
    await importLegacyReports(pool); await importLegacyReports(pool);
    assert.equal((await pool.query("SELECT id FROM moderation_reports WHERE legacy_type='app'")).rowCount,2);
    assert.equal((await pool.query("SELECT id FROM moderation_reports WHERE legacy_type='app_message'")).rowCount,2);
    assert.equal((await pool.query("SELECT id FROM moderation_cases WHERE target_id < 0 AND target_type IN ('app','app_message')")).rowCount,2);
    // INSERT ... SELECT may assign new IDs in either join order. Match the
    // original report identity and verify both live and deleted snapshots.
    const migratedMessages = await pool.query(`SELECT r.legacy_id, r.evidence, old.content_snapshot
      FROM moderation_reports r JOIN chat_message_reports old ON old.id = r.legacy_id
      WHERE r.legacy_type = 'app_message' ORDER BY r.legacy_id`);
    assert.deepEqual(migratedMessages.rows.map(r => r.evidence.content), ['Original legacy post','Deleted legacy post']);
    for (const r of migratedMessages.rows) assert.equal(r.evidence.content,r.content_snapshot);
    assert.equal((await get('/api/apps/reported-app/report','alice',{method:'POST',body:JSON.stringify({reason:'spam'})})).status,202);
    for (const route of ['/api/apps/reported-app/report','/api/reports']) {
      const ownReport = await get(route,'bob',{method:'POST',body:JSON.stringify({targetType:'app',target:'reported-app',reason:'spam'})});
      assert.equal(ownReport.status,400,'own app reports are still rejected');
      assert.equal((await ownReport.json()).error,'You cannot report your own app.');
    }
    assert.equal((await get(`/api/apps/reported-app/messages/${chat.id}/report`,'alice',{method:'POST',body:JSON.stringify({reason:'spam'})})).status,202);
    assert.equal((await get(`/api/apps/wrong-app/messages/${chat.id}/report`,'alice',{method:'POST',body:JSON.stringify({reason:'spam'})})).status,404);
    assert.equal((await get('/api/users/author/report','alice',{method:'POST',body:JSON.stringify({reason:'spam'})})).status,202);
    const legacyAppReport=(await pool.query('SELECT id FROM app_reports WHERE app_id=$1',[app.id])).rows[0];
    assert.equal((await get(`/api/admin/app-reports/${legacyAppReport.id}/resolve`,'readonly',{method:'POST'})).status,403);
    assert.equal((await get(`/api/admin/app-reports/${legacyAppReport.id}/resolve`,'admin',{method:'POST'})).status,200);
    assert.equal((await pool.query('SELECT status FROM app_reports WHERE id=$1',[legacyAppReport.id])).rows[0].status,'resolved');
    assert.equal((await pool.query("SELECT status FROM moderation_cases WHERE target_type='app' AND target_id=$1",[app.id])).rows[0].status,'resolved');
    await pool.query("UPDATE moderation_cases SET status='resolved',closed_at=NOW()-INTERVAL '181 days' WHERE target_type IN ('app','app_message')");
    await moderation.purgeExpired(pool); await importLegacyReports(pool);
    assert.equal((await pool.query('SELECT id FROM app_reports')).rowCount,0);
    assert.equal((await pool.query('SELECT id FROM chat_message_reports')).rowCount,0);
    assert.ok((await pool.query("SELECT evidence FROM moderation_reports WHERE legacy_type IN ('app','app_message')")).rows.every(r=>r.evidence===null));

    // No report-count threshold applies automatic penalties; quota is per reporter.
    await pool.query(`INSERT INTO moderation_reports (case_id,cycle,reporter_user_id,reason) SELECT $1,100+n,$2,'spam' FROM generate_series(1,10) n`,[c.id,outsider.id]);
    await assert.rejects(moderation.submitReport(pool,outsider,{targetType:'app',target:'reported-app',reason:'spam'}),{status:429});
    assert.equal((await pool.query('SELECT moderation_suspended_at FROM apps WHERE id=$1',[app.id])).rows[0].moderation_suspended_at,null);
  } finally {
    if (server) await new Promise(resolve=>server.close(resolve));
    if (pool) await pool.end();
    // pg-pool can resolve end() before its sockets emit end. Never force-drop
    // the database while those clients are still receiving server messages.
    await Promise.all(connectionsClosed);
    await root.query(`DROP DATABASE IF EXISTS ${name}`);
    await root.end();
  }
});

test('participation restrictions preserve safety/settings/history while denying social/build mutations', () => {
  for (const route of ['/api/apps','/API/APPS','/api/apps/a/messages','/api/apps/a/proposal-handoffs','/api/sessions/42/proposal-handoff/build','/api/conversations/1/messages','/api/issues/1/vote','/api/invites/2/accept','/api/approver-invites/2/accept']) assert.equal(participationWrite(route,'POST'),true,route);
  for (const route of ['/api/reports','/api/me/blocks/2','/api/me/account','/api/conversations/1/read','/api/conversations/1/leave','/api/conversations/1/messages/2/report','/api/profiles/a/report','/api/users/a/report','/api/apps/a/report','/api/apps/a/messages/1/report']) assert.equal(participationWrite(route,'POST'),false,route);
  assert.equal(participationWrite('/api/conversations/1/messages','GET'),false);
});
