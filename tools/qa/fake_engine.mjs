// tools/qa/fake_engine.mjs — a bridge-protocol engine for QA self-tests.
//
// Serves /state, /cmd, /log with the real token rule, over the fixture
// element set. Cvar writes move/scale/toggle elements; a vid_width/vid_height
// write rescales every rect proportionally — the *correct* behaviour the
// invariants encode. `fault` breaks one element's rescale on purpose so the
// planted-fault drill can prove the matrix catches it. This is a harness for
// testing the QA machinery itself; the real subject is always a real engine.

import { readFile } from 'node:fs/promises';
import http from 'node:http';

export async function startFakeEngine({ token = 'qa-token', fault = null, port = 0 } = {}) {
	const fixture = JSON.parse(await readFile(
		new URL('../../hud_web_ui/fixtures/state.json', import.meta.url), 'utf8'));

	const state = structuredClone(fixture);
	const logLines = [];
	const looseCvars = {};   // killfeed, hud-mode and any other non-element cvars

	// The real engine clamps every rect into its place bounds
	// (HUD_PrepareDraw); without modelling that, the master cfg's stress
	// offsets would make containment fire on correct behaviour.
	function clamp(e) {
		if (!e.rect) return;
		e.rect.w = Math.min(e.rect.w, state.screen.vid_width);
		e.rect.h = Math.min(e.rect.h, state.screen.vid_height);
		e.rect.x = Math.min(Math.max(e.rect.x, 0), state.screen.vid_width - e.rect.w);
		e.rect.y = Math.min(Math.max(e.rect.y, 0), state.screen.vid_height - e.rect.h);
	}

	function rescale(width, height) {
		const rx = width / state.screen.vid_width;
		const ry = height / state.screen.vid_height;
		for (const e of state.elements) {
			if (!e.rect) continue;
			if (fault && e.name === fault) {
				// The planted fault: position scales, size does not.
				e.rect = { x: e.rect.x * rx, y: e.rect.y * ry, w: e.rect.w, h: e.rect.h };
				continue;
			}
			e.rect = { x: e.rect.x * rx, y: e.rect.y * ry, w: e.rect.w * rx, h: e.rect.h * ry };
		}
		state.screen.vid_width = width;
		state.screen.vid_height = height;
		for (const e of state.elements) clamp(e);
	}

	function setCvar(name, value) {
		if (name === 'vid_width') { rescale(Number(value), state.screen.vid_height); return; }
		if (name === 'vid_height') { rescale(state.screen.vid_width, Number(value)); return; }
		const match = name.match(/^hud_(.+?)_(pos_x|pos_y|show|scale|[a-z0-9_]+)$/);
		const element = match && state.elements.find(
			(e) => name.startsWith(`hud_${e.name}_`));
		if (!element) { looseCvars[name] = value; return; }
		const param = name.slice(`hud_${element.name}_`.length);
		if (param === 'pos_x' || param === 'pos_y') {
			const delta = Number(value) - Number(element[param]);
			element[param] = value;   // engine keeps the exact string (round-trip rule)
			if (element.rect) {
				element.rect[param === 'pos_x' ? 'x' : 'y'] += delta;
				clamp(element);
			}
			return;
		}
		if (param === 'show') {
			element.shown = Number(value) !== 0;
			if (!element.shown) element.rect = null;
			return;
		}
		if (param === 'scale' && element.rect) {
			const previous = Number(element.cvars[name] ?? 1) || 1;
			const factor = (Number(value) || 1) / previous;
			element.rect.w *= factor;
			element.rect.h *= factor;
			clamp(element);
		}
		element.cvars[name] = value;
	}

	const server = http.createServer(async (request, response) => {
		const url = new URL(request.url, 'http://fake.invalid');
		if (url.searchParams.get('t') !== token) {
			response.writeHead(403).end('{"ok":false,"error":"forbidden"}');
			return;
		}
		const reqId = request.headers['x-hud-req'];
		logLines.push(`${request.method} ${url.pathname} 200 0B 0.1ms${reqId ? ` req=${reqId}` : ''}`);
		if (url.pathname === '/state') {
			// The real engine reports integer console pixels; keeping internal
			// floats but serialising rounded avoids fake-only ULP drift.
			const elements = state.elements.map((e) => ({
				...e,
				rect: e.rect && Object.fromEntries(
					Object.entries(e.rect).map(([k, v]) => [k, Math.round(v)])),
			}));
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ ...state, elements, killfeed: {
				r_tracker: looseCvars.r_tracker ?? '1',
				con_fragmessages: looseCvars.con_fragmessages ?? '1',
				cl_useimagesinfraglog: looseCvars.cl_useimagesinfraglog ?? '0',
			} }));
			return;
		}
		if (url.pathname === '/log') {
			response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
			response.end(logLines.join('\n') + '\n');
			return;
		}
		if (url.pathname === '/cmd' && request.method === 'POST') {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const { cmd } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			const line = cmd.replace(/^set\s+/, '');
			const space = line.indexOf(' ');
			if (space > 0) {
				setCvar(line.slice(0, space), line.slice(space + 1).replace(/^"|"$/g, ''));
			}
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{"ok":true}');
			return;
		}
		response.writeHead(404).end('{"ok":false,"error":"not found"}');
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});
	return {
		origin: `http://127.0.0.1:${server.address().port}`,
		token,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}
