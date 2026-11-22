import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { HelloHop } from '../nodes/HelloHop/HelloHop.node.ts';
import { HelloHopApi } from '../credentials/HelloHopApi.credentials.ts';
import { HelloHopTrigger, isFromHelloHop } from '../nodes/HelloHopTrigger/HelloHopTrigger.node.ts';
import { executeContext, webhookContext, type Transport } from './mock.mts';

const node = new HelloHop();
const spec = JSON.parse(readFileSync(new URL('./fixtures/public-v1.json', import.meta.url), 'utf8'));
const t = (extra: Partial<Transport> = {}): Transport => ({ calls: [], ...extra });
const sendText = (more: Record<string, unknown> = {}) => ({
	resource: 'message',
	operation: 'sendText',
	to: '+66 8XX XXX XXX',
	text: 'Thanks, see you tomorrow',
	options: {},
	...more,
});
const run = (params: Record<string, unknown>[], transport: Transport, cof = false) =>
	node.execute.call(executeContext(params, transport, cof));

// Spec sanity: the routes and statuses these nodes rely on exist.
test('spec documents the routes and statuses the nodes use', () => {
	const send = spec.paths['/sessions/{name}/messages'].post.responses;
	for (const code of ['200', '202', '409', '429', '503', '504']) assert.ok(send[code], code);
	assert.ok(spec.paths['/sessions/{name}'].get, 'credential test route');
	assert.ok(spec.paths['/sessions/{name}/chats/{chat}/messages'].get);
	assert.ok(spec.paths['/sessions/{name}/groups'].post);
	assert.ok(spec.paths['/sessions/{name}/groups/{group}/participants'].post);
});

test('credential test reads the channel and sends nothing', () => {
	const req = new HelloHopApi().test.request;
	assert.equal(req.method, 'GET');
	assert.match(String(req.url), /\/sessions\//);
});

test('send text 200: sent, normalized recipient, no key without a user field', async () => {
	const tr = t();
	const [[row]] = await run([sendText()], tr);
	assert.equal(row.json.outcome, 'sent');
	assert.ok(row.json.id);
	assert.equal(row.json.status, 'server_ack');
	assert.deepEqual(tr.calls[0].body, { type: 'text', to: '668XXXXXXXX', text: 'Thanks, see you tomorrow' });
	assert.equal(tr.calls[0].headers['Idempotency-Key'], undefined);
	assert.match(tr.calls[0].headers.Authorization, /^Bearer /);
});

test('send text 202: queued', async () => {
	const [[row]] = await run([sendText()], t({ prefer: 202 }));
	assert.equal(row.json.outcome, 'queued');
});

test('idempotency key is deterministic and a replay is flagged', async () => {
	const tr = t({ canned: { status: 200, body: { id: 'A1', status: 'server_ack' }, headers: { 'Idempotent-Replayed': 'true' } } });
	const params = sendText({ options: { idempotencyKey: 'order-123' } });
	const [[a]] = await run([params, params], tr);
	assert.equal(a.json.replayed, true);
	assert.equal(tr.calls[0].headers['Idempotency-Key'], 'n8n-order-123-0');
	assert.equal(tr.calls[1].headers['Idempotency-Key'], 'n8n-order-123-1');
	const tr2 = t({ canned: { status: 200, body: {} } });
	await run([sendText({ options: { idempotencyKey: 'order-123', keyWithIndex: false } })], tr2);
	assert.equal(tr2.calls[0].headers['Idempotency-Key'], 'n8n-order-123');
});

test('409 conflict from the API is failed', async () => {
	const [[row]] = await run([sendText()], t({ prefer: 409 }), true);
	assert.equal(row.json.outcome, 'failed');
});

test('409 idempotency_uncertain is unknown; throws unless continue on fail', async () => {
	const canned = { status: 409, body: { code: 'idempotency_uncertain', error: 'x', ambiguous: true } };
	const [[row]] = await run([sendText()], t({ canned }), true);
	assert.equal(row.json.outcome, 'unknown');
	await assert.rejects(run([sendText()], t({ canned })), /Outcome: unknown/);
});

test('429 gives a retry hint from Retry-After', async () => {
	const canned = { status: 429, body: { code: 'rate_limited', error: 'x' }, headers: { 'Retry-After': '7' } };
	const [[row]] = await run([sendText()], t({ canned }), true);
	assert.equal(row.json.outcome, 'retry_later');
	assert.equal(row.json.retryAfterSeconds, 7);
});

test('503 ambiguous true is unknown, false is retry_later', async () => {
	const mk = (ambiguous: boolean) => ({ status: 503, body: { code: 'lane_reclaimed', error: 'x', ambiguous } });
	const [[u]] = await run([sendText()], t({ canned: mk(true) }), true);
	const [[r]] = await run([sendText()], t({ canned: mk(false) }), true);
	assert.equal(u.json.outcome, 'unknown');
	assert.equal(r.json.outcome, 'retry_later');
});

test('504 and a timeout are unknown', async () => {
	const [[a]] = await run([sendText()], t({ canned: { status: 504, body: { code: 'send_unconfirmed', ambiguous: true } } }), true);
	const [[b]] = await run([sendText()], t({ fail: 'ETIMEDOUT' }), true);
	assert.equal(a.json.outcome, 'unknown');
	assert.equal(b.json.outcome, 'unknown');
});

test('send media (image URL) is accepted by the spec mock', async () => {
	const tr = t();
	const [[row]] = await run(
		[{ resource: 'message', operation: 'sendMedia', to: '66XXXXXXXXX', mediaType: 'image', url: 'https://example.com/a.jpg', caption: 'Hi', options: {} }],
		tr,
	);
	assert.equal(row.json.outcome, 'sent');
	assert.equal(tr.calls[0].body.media_type, 'image');
});

test('conversation read pages with limit and before', async () => {
	const tr = t();
	const [rows] = await run([{ resource: 'conversation', operation: 'read', chat: '66XXXXXXXXX', limit: 25, before: 'AbC123' }], tr);
	assert.ok(Array.isArray(rows[0].json.messages));
	assert.match(tr.calls[0].url, /chats\/66XXXXXXXXX@s\.whatsapp\.net\/messages\?limit=25&before=AbC123/);
});

test('group create against the spec mock', async () => {
	const [[row]] = await run([{ resource: 'group', operation: 'create', subject: 'Team', participants: '66XXXXXXXXX' }], t());
	assert.equal(row.json.outcome, 'done');
});

test('group add: batches of 50 with per-person results', async () => {
	const people = Array.from({ length: 60 }, (_, n) => `66${String(n).padStart(9, '0')}`);
	const tr = t({
		canned: (req) => ({
			status: 200,
			body: {
				results: req.body.participants.map((p: string) =>
					p.endsWith('7') ? { jid: p, status: 'error_403', error: 'not allowed' } : { jid: p, status: 'ok' },
				),
			},
		}),
	});
	const [rows] = await run([{ resource: 'group', operation: 'addParticipants', group: '120363000000000001@g.us', participants: people.join(',') }], tr);
	assert.equal(tr.calls.length, 2);
	assert.equal(tr.calls[0].body.participants.length, 50);
	assert.equal(tr.calls[1].body.participants.length, 10);
	assert.equal(rows.length, 60);
	assert.equal(rows.filter((r) => r.json.ok).length, 54);
	assert.equal(rows.find((r) => r.json.jid === people[7])?.json.status, 'error_403');
});

test('group add: an ambiguous first batch stops the rest', async () => {
	const people = Array.from({ length: 60 }, (_, n) => `66${String(n).padStart(9, '0')}`);
	const tr = t({ canned: { status: 503, body: { code: 'lane_reclaimed', ambiguous: true } } });
	const [rows] = await run([{ resource: 'group', operation: 'addParticipants', group: '120363000000000001@g.us', participants: people }], tr);
	assert.equal(tr.calls.length, 1);
	assert.equal(rows[0].json.status, 'unknown');
	assert.equal(rows[59].json.status, 'not_attempted');
});

// Trigger
const secret = 'x'.repeat(24);
const envelope = (type: string, payload: object = {}) => Buffer.from(JSON.stringify({ id: 'evt_1', type, session: 'chan1', payload }));
const sign = (body: Buffer, key = secret) => createHmac('sha256', key).update(body).digest('hex');
const trigger = new HelloHopTrigger();

test('trigger: valid signature starts the workflow with the envelope', async () => {
	const body = envelope('message', { text: 'hi', from_me: false });
	const { ctx } = webhookContext({ rawBody: body, signature: sign(body), secret });
	const res = await trigger.webhook.call(ctx);
	assert.equal((res.workflowData![0][0].json as any).id, 'evt_1');
});

test('trigger: bad, missing and wrong-key signatures are 401', async () => {
	const body = envelope('message');
	for (const opts of [
		{ rawBody: body, signature: 'a'.repeat(64), secret },
		{ rawBody: body, signature: sign(body, 'y'.repeat(24)), secret },
		{ rawBody: body, secret },
		{ rawBody: undefined, signature: sign(body), secret },
		{ rawBody: body, signature: sign(body), secret: '' },
	]) {
		const { ctx, out } = webhookContext(opts);
		const res = await trigger.webhook.call(ctx);
		assert.equal(out.status, 401);
		assert.equal(res.noWebhookResponse, true);
		assert.equal(res.workflowData, undefined);
	}
});

test('trigger: a changed body fails, signature checks the raw bytes', () => {
	const body = envelope('message');
	assert.equal(isFromHelloHop(body, sign(body), secret), true);
	assert.equal(isFromHelloHop(Buffer.from(body.toString() + ' '), sign(body), secret), false);
});

test('trigger: unsubscribed events and own messages are acknowledged and dropped', async () => {
	const status = envelope('message.status');
	const a = webhookContext({ rawBody: status, signature: sign(status), secret, events: ['message'] });
	assert.equal((await trigger.webhook.call(a.ctx)).workflowData, undefined);
	const mine = envelope('message', { from_me: true });
	const b = webhookContext({ rawBody: mine, signature: sign(mine), secret, ignoreFromMe: true });
	const res = await trigger.webhook.call(b.ctx);
	assert.equal(res.workflowData, undefined);
	assert.equal(b.out.status, 0);
});
