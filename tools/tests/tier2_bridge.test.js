import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';

import { Bridge, BridgeError } from '../../hud_web_ui/core/bridge.js';
import * as syslog from '../../hud_web_ui/core/log.js';

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
			headers: request.headers,
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

test('a rejected command surfaces the hud_web diagnostic once without impersonating token loss', async (t) => {
	syslog._reset();
	const s = await localStub(t, (_request, response) =>
		json(response, 403, { ok: false, error: 'command not permitted' }));
	if (!s) return;
	t.after(s.close);
	await assert.rejects(s.bridge.send('demo_setspeed 0'), (err) => {
		assert.ok(err instanceof BridgeError);
		assert.equal(err.status, 403);
		assert.match(err.message, /command/i);
		return true;
	});
	const diagnostics = syslog.snapshot().filter((entry) => /\[hud_web\] cmd rejected/.test(entry.msg));
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0].level, 'warn');
	assert.equal(diagnostics[0].data.command, 'demo_setspeed 0');
	assert.equal(syslog.snapshot().filter((entry) => /token rejected/.test(entry.msg)).length, 0);
	syslog._reset();
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

test('every bridge request carries a unique X-HUD-Req correlation id', async (t) => {
	const s = await localStub(t, (_request, response) => json(response, 200, fixture));
	if (!s) return;
	t.after(s.close);
	await s.bridge.state();
	await s.bridge.state();
	const ids = s.requests.map((r) => r.headers['x-hud-req']);
	assert.ok(ids[0] && ids[1]);
	assert.notEqual(ids[0], ids[1]);
});

test('logText returns the engine log and degrades to empty on failure', async (t) => {
	const s = await localStub(t, (request, response) => {
		if (request.url.pathname === '/log') {
			response.writeHead(200, { 'content-type': 'text/plain' });
			response.end('[hud_web] GET /state 200');
		} else {
			json(response, 200, fixture);
		}
	});
	if (!s) return;
	assert.equal(await s.bridge.logText(), '[hud_web] GET /state 200');
	assert.equal(s.requests.at(-1).url.searchParams.get('t'), 'stub token');
	await s.close();
	assert.equal(await s.bridge.logText(), '');
});

test('an outage logs one lost-contact error and one reconnect, not one per poll', async (t) => {
	syslog._reset();
	const s = await localStub(t, (_request, response) => json(response, 200, fixture));
	if (!s) return;
	await s.bridge.state();
	await s.close();
	await assert.rejects(s.bridge.state());
	await assert.rejects(s.bridge.state());
	await assert.rejects(s.bridge.state());
	const errors = syslog.snapshot({ level: 'error' });
	assert.equal(errors.length, 1);
	assert.match(errors[0].msg, /Lost contact/);

	// Engine comes back on the same port: exactly one reconnect transition.
	const port = Number(new URL(s.bridge.origin).port);
	const revived = http.createServer((_request, response) => json(response, 200, fixture));
	await new Promise((resolve, reject) => {
		revived.once('error', reject);
		revived.listen(port, '127.0.0.1', resolve);
	});
	t.after(() => new Promise((resolve) => revived.close(resolve)));
	await s.bridge.state();
	await s.bridge.state();
	const reconnects = syslog.snapshot({ area: 'bridge' }).filter((e) => /reconnected/.test(e.msg));
	assert.equal(reconnects.length, 1);
	syslog._reset();
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
