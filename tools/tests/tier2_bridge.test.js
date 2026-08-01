import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';

import { Bridge, BridgeError } from '../../hud_web_ui/core/bridge.js';

const fixture = JSON.parse(await readFile(
	new URL('../../hud_web_ui/fixtures/state.json', import.meta.url), 'utf8'));
let sandboxSkipReported = false;

async function stub(handler) {
	const requests = [];
	const server = http.createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const record = {
			method: request.method,
			url: new URL(request.url, 'http://stub.invalid'),
			body: Buffer.concat(chunks).toString('utf8'),
		};
		requests.push(record);
		await handler(record, response);
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	return {
		bridge: new Bridge({ token: 'stub token', origin: `http://127.0.0.1:${address.port}` }),
		requests,
		close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
	};
}

async function localStub(t, handler) {
	try {
		return await stub(handler);
	} catch (err) {
		if (err?.code === 'EPERM' || err?.code === 'EACCES') {
			if (!sandboxSkipReported) {
				console.error(`TIER 2 JS SKIP: loopback listeners are forbidden by this sandbox (${err.code}).`);
				sandboxSkipReported = true;
			}
			t.skip(`loopback listeners are forbidden by this sandbox (${err.code})`);
			return null;
		}
		throw err;
	}
}

function json(response, status, body) {
	response.writeHead(status, { 'content-type': 'application/json' });
	response.end(JSON.stringify(body));
}

test('token is attached as ?t= to every bridge request', async (t) => {
	const s = await localStub(t, (request, response) => {
		if (request.url.pathname === '/state') json(response, 200, fixture);
		else if (request.url.pathname === '/fonts') json(response, 200, { available: [] });
		else if (request.url.pathname === '/configs') json(response, 200, { available: [] });
		else if (request.url.pathname === '/palette') json(response, 200, { colors: [] });
		else json(response, 200, { ok: true });
	});
	if (!s) return;
	t.after(s.close);
	await s.bridge.state();
	await s.bridge.fonts();
	await s.bridge.configs();
	await s.bridge.palette();
	await s.bridge.send('hud_face_pos_x 1');
	assert.deepEqual(s.requests.map((r) => r.url.searchParams.get('t')),
		Array(5).fill('stub token'));
	assert.equal(s.requests.at(-1).method, 'POST');
	assert.deepEqual(JSON.parse(s.requests.at(-1).body), { cmd: 'hud_face_pos_x 1' });
});

test('403 is the sole non-retryable BridgeError status', async (t) => {
	const s = await localStub(t, (_request, response) => json(response, 403, { error: 'denied' }));
	if (!s) return;
	t.after(s.close);
	await assert.rejects(s.bridge.state(), (err) => {
		assert.ok(err instanceof BridgeError);
		assert.equal(err.status, 403);
		assert.match(err.message, /no longer valid/);
		return true;
	});
});

test('transport failure is wrapped as a retryable status-zero BridgeError', async (t) => {
	const s = await localStub(t, (_request, response) => json(response, 200, fixture));
	if (!s) return;
	await s.close();
	await assert.rejects(s.bridge.state(), (err) => {
		assert.ok(err instanceof BridgeError);
		// Only status 403 stops retries, so transport status zero remains retryable.
		assert.equal(err.status, 0);
		assert.match(err.message, /Lost contact/);
		return true;
	});
});

test('cfg_save enables cfg_backup first and restores it after success', async (t) => {
	const s = await localStub(t, (request, response) => {
		if (request.url.pathname === '/configs') {
			json(response, 200, { backup_enabled: false });
		} else {
			json(response, 200, { ok: true });
		}
	});
	if (!s) return;
	t.after(s.close);
	await s.bridge.save({ name: 'duel.cfg', keepBackup: true });
	assert.deepEqual(s.requests.map((r) => r.url.pathname), ['/configs', '/cmd', '/cmd', '/cmd']);
	assert.deepEqual(s.requests.slice(1).map((r) => JSON.parse(r.body).cmd), [
		'cfg_backup 1', 'cfg_save duel.cfg', 'cfg_backup 0',
	]);
});

test('cfg_save restores cfg_backup even when saving fails', async (t) => {
	let commands = 0;
	const s = await localStub(t, (request, response) => {
		if (request.url.pathname === '/configs') {
			json(response, 200, { backup_enabled: false });
			return;
		}
		commands++;
		json(response, commands === 2 ? 500 : 200, { ok: commands !== 2 });
	});
	if (!s) return;
	t.after(s.close);
	await assert.rejects(s.bridge.save({ name: 'duel.cfg', keepBackup: true }), /500/);
	assert.deepEqual(s.requests.slice(1).map((r) => JSON.parse(r.body).cmd), [
		'cfg_backup 1', 'cfg_save duel.cfg', 'cfg_backup 0',
	]);
});

test('hud_export never reads or mutates cfg_backup', async (t) => {
	const s = await localStub(t, (_request, response) => json(response, 200, { ok: true }));
	if (!s) return;
	t.after(s.close);
	await s.bridge.save({ name: 'minimal.cfg', hudOnly: true, keepBackup: true });
	assert.deepEqual(s.requests.map((r) => r.url.pathname), ['/cmd']);
	assert.equal(JSON.parse(s.requests[0].body).cmd, 'hud_export minimal.cfg');
});

test('frameUrl changes its nonce while retaining token authentication', () => {
	const bridge = new Bridge({ token: 'abc', origin: 'http://127.0.0.1:1' });
	const first = new URL(bridge.frameUrl(10));
	const second = new URL(bridge.frameUrl(11));
	assert.equal(first.searchParams.get('t'), 'abc');
	assert.equal(second.searchParams.get('t'), 'abc');
	assert.equal(first.searchParams.get('n'), '10');
	assert.equal(second.searchParams.get('n'), '11');
	assert.notEqual(first.href, second.href);
});
