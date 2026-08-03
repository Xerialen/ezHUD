import assert from 'node:assert/strict';
import test from 'node:test';

import { Bridge, BridgeError } from '../fte-adapter.js';

// A stand-in for the wasm runtime. The real Module hands back a char* that
// UTF8ToString decodes; nothing here cares which pointer it was, so the fake
// returns a fixed one and decodes to whatever the test set.
function fakeEngine(state, { canvas = { width: 1024, height: 576 } } = {}) {
	const sent = [];
	const json = { text: typeof state === 'string' ? state : JSON.stringify(state) };
	return {
		sent,
		json,
		engine: {
			module: {
				canvas,
				_EZHud_StateJSON: () => 1,
				UTF8ToString: (ptr) => (ptr ? json.text : ''),
			},
			ftec: { cbufadd: (line) => sent.push(line) },
		},
	};
}

const oneElement = {
	protocol: 1,
	engine: 'fteqw ezhud (web)',
	screen: { vid_width: 512, vid_height: 288, scr_con_current: 0 },
	elements: [
		{
			name: 'health', shown: true, place: 'screen', parent: null,
			align_x: 'left', align_y: 'top', pos_x: 0, pos_y: 0, order: 5, frame: 0,
			rect: { x: 4, y: 4, w: 45, h: 20 },
			cvars: { hud_health_scale: '2', hud_health_style: '0' },
		},
	],
};

test('state parses the export and injects physical from the engine canvas', async () => {
	const fake = fakeEngine(oneElement);
	const bridge = new Bridge(fake);
	const state = await bridge.state();

	// The plugin deliberately omits `physical`: the page owns the size of the
	// picture, the same way the ezQuake bridge reads it from the framebuffer it
	// is about to capture.
	assert.deepEqual(state.physical, [1024, 576]);
	assert.equal(state.screen.vid_width, 512);
	assert.equal(bridge.lastState, state);
});

test('state refuses before the runtime is up, as LOST rather than DENIED', async () => {
	const bridge = new Bridge({ engine: { module: null, ftec: null } });
	assert.equal(bridge.ready(), false);
	await assert.rejects(() => bridge.state(), (err) => {
		assert.ok(err instanceof BridgeError);
		// 403 is the one status app.js stops polling on. Anything else keeps
		// the retry loop alive, which is the whole point of throwing here.
		assert.notEqual(err.status, 403);
		assert.match(err.message, /still starting/);
		return true;
	});
});

test('a refused state does not poison the next one', async () => {
	const engine = { module: null, ftec: null };
	const bridge = new Bridge({ engine });
	await assert.rejects(() => bridge.state());

	const fake = fakeEngine(oneElement);
	engine.module = fake.engine.module;
	engine.ftec = fake.engine.ftec;
	const state = await bridge.state();
	assert.equal(state.elements[0].name, 'health');
});

test('state reports malformed JSON rather than throwing a SyntaxError at app.js', async () => {
	const bridge = new Bridge(fakeEngine('{"protocol":1,'));
	await assert.rejects(() => bridge.state(), /malformed JSON/);
});

test('send passes allowlisted commands through to cbufadd, newline included', async () => {
	const fake = fakeEngine(oneElement);
	const bridge = new Bridge(fake);
	await bridge.send('hud_recalculate');
	await bridge.send('hud_health_pos_x 12');
	assert.deepEqual(fake.sent, ['hud_recalculate\n', 'hud_health_pos_x 12\n']);
});

test('send refuses chaining, expansion, newlines, hud_web and anything unlisted', async () => {
	const fake = fakeEngine(oneElement);
	const bridge = new Bridge(fake);
	const refused = [
		'hud_health_pos_x 1; quit',           // chaining
		'hud_tracking_format $rcon_password', // Cmd_ExpandString runs after the check
		'hud_health_pos_x 1\nquit',           // a second line is a second command
		'hud_web 0',                          // the bridge's own settings
		'hud_web_port 1234',
		'exec autoexec.cfg',                  // not on the list, and never will be
		'quit',
		'togglehud health',                   // falls back to *any* cvar (hud.c:498)
		'',
	];
	for (const line of refused) {
		await assert.rejects(() => bridge.send(line), (err) => {
			assert.equal(err.status, 403);
			return true;
		}, `expected refusal: ${JSON.stringify(line)}`);
	}
	assert.deepEqual(fake.sent, []);
});

test('setCvar quotes values with spaces, and the empty value', async () => {
	const fake = fakeEngine(oneElement);
	const bridge = new Bridge(fake);
	await bridge.setCvar('hud_health_pos_x', 12);
	await bridge.setCvar('hud_clock_format', '%H:%M %p');
	await bridge.setCvar('hud_clock_format', '');
	assert.deepEqual(fake.sent, [
		'hud_health_pos_x 12\n',
		'hud_clock_format "%H:%M %p"\n',
		'hud_clock_format ""\n',
	]);
});

test('exportHudCfg writes sorted cvar "value" lines from the last state', async () => {
	const bridge = new Bridge(fakeEngine(oneElement));
	await bridge.state();
	const lines = bridge.exportHudCfg().trimEnd().split('\n');

	assert.match(lines[0], /^\/\//);
	const body = lines.slice(2);
	assert.deepEqual(body, [...body].sort((a, b) => a.localeCompare(b)));
	assert.ok(body.includes('hud_health_scale "2"'));
	// The placement fields live on hud_t rather than in params, so they are
	// absent from `cvars` and have to be rebuilt from the element itself.
	assert.ok(body.includes('hud_health_pos_x "0"'));
	assert.ok(body.includes('hud_health_show "1"'));
	assert.ok(body.includes('hud_health_place "screen"'));
});

test('exportFullCfg rewrites applied lines and reproduces the rest byte-identical', async () => {
	const bridge = new Bridge(fakeEngine(oneElement));
	await bridge.state();
	bridge.retainedLines = [
		{ raw: '// my hud', cvar: null, applied: false },
		{ raw: 'bind SPACE +jump', cvar: null, applied: false },
		{ raw: 'seta hud_health_scale    1', cvar: 'hud_health_scale', applied: true },
		{ raw: '', cvar: null, applied: false },
		{ raw: 'alias  rl "impulse 7"', cvar: null, applied: false },
		// Applied, but the engine no longer reports it: keep the user's line
		// rather than dropping a setting we cannot speak for.
		{ raw: 'hud_gone_pos_x 3', cvar: 'hud_gone_pos_x', applied: true },
	];

	const out = bridge.exportFullCfg().split('\n');
	assert.deepEqual(out.slice(0, 6), [
		'// my hud',
		'bind SPACE +jump',
		'hud_health_scale "2"',   // rewritten to the engine's current value
		'',
		'alias  rl "impulse 7"',  // spacing and quoting untouched
		'hud_gone_pos_x 3',
	]);
	// No defaults captured, so nothing is appended.
	assert.equal(out.length, 7);
	assert.equal(out[6], '');
});

test('an applied line whose value the engine still holds survives byte-identical', async () => {
	const bridge = new Bridge(fakeEngine(oneElement));
	await bridge.state();
	bridge.retainedLines = [
		// Column-aligned the way real configs are; the engine reports "2".
		{ raw: 'hud_health_scale                      "2"', cvar: 'hud_health_scale', value: '2', applied: true },
		// Same number spelled differently: numerically equal, so still theirs.
		{ raw: 'hud_health_pos_x  0.0', cvar: 'hud_health_pos_x', value: '0.0', applied: true },
		// Genuinely edited in the editor (engine holds "0", file said 1.5).
		{ raw: 'hud_health_style  1.5', cvar: 'hud_health_style', value: '1.5', applied: true },
	];
	const out = bridge.exportFullCfg().trimEnd().split('\n');
	assert.deepEqual(out, [
		'hud_health_scale                      "2"',
		'hud_health_pos_x  0.0',
		'hud_health_style "0"',
	]);
});

test('captureDefaults plus a changed cvar appends it under // added in ez-hud', async () => {
	const fake = fakeEngine(oneElement);
	const bridge = new Bridge(fake);
	await bridge.state();
	bridge.captureDefaults();

	// The user drags health across the screen after importing a config that
	// never mentioned pos_x.
	const moved = structuredClone(oneElement);
	moved.elements[0].pos_x = 40;
	fake.json.text = JSON.stringify(moved);
	await bridge.state();

	bridge.retainedLines = [{ raw: 'bind SPACE +jump', cvar: null, applied: false }];
	const out = bridge.exportFullCfg().trimEnd().split('\n');
	assert.deepEqual(out, [
		'bind SPACE +jump',
		'',
		'// added in ez-hud',
		'hud_health_pos_x "40"',
	]);
});

test('a cvar already written by a retained line is not appended twice', async () => {
	const fake = fakeEngine(oneElement);
	const bridge = new Bridge(fake);
	await bridge.state();
	bridge.captureDefaults();

	const moved = structuredClone(oneElement);
	moved.elements[0].pos_x = 40;
	fake.json.text = JSON.stringify(moved);
	await bridge.state();

	bridge.retainedLines = [{ raw: 'hud_health_pos_x 0', cvar: 'hud_health_pos_x', applied: true }];
	const out = bridge.exportFullCfg().trimEnd().split('\n');
	assert.deepEqual(out, ['hud_health_pos_x "40"']);
});

test('a cvar the defaults snapshot never saw counts as an addition', async () => {
	const fake = fakeEngine({ ...oneElement, elements: [] });
	const bridge = new Bridge(fake);
	await bridge.state();
	bridge.captureDefaults();          // empty: no elements registered yet

	fake.json.text = JSON.stringify(oneElement);
	await bridge.state();

	const out = bridge.exportFullCfg();
	assert.match(out, /\/\/ added in ez-hud/);
	assert.match(out, /hud_health_scale "2"/);
});

test('the ledger synthesizes hud_modes and killfeed, flagged synthetic', async () => {
	const fake = fakeEngine(oneElement);
	const bridge = new Bridge(fake);
	let state = await bridge.state();

	// The plugin exports neither block; the adapter answers from its ledger and
	// says so, which is what the view's honesty note keys on.
	assert.equal(state.hud_modes.synthetic, true);
	assert.equal(state.killfeed.synthetic, true);
	// ezQuake's default seed: this fake has no boot launch arguments.
	assert.equal(state.hud_modes.scr_newhud, 0);
	assert.equal(state.killfeed.r_tracker, '1');

	await bridge.setCvar('r_tracker', 0);
	await bridge.setCvar('scr_newhud', 2);
	await bridge.setCvar('viewsize', 110);
	state = await bridge.state();
	assert.equal(state.killfeed.r_tracker, '0');
	assert.equal(state.hud_modes.scr_newhud, 2);
	// Same derivations as hud_web_state.c: 2 draws both systems.
	assert.equal(state.hud_modes.classic_drawn, true);
	assert.equal(state.hud_modes.new_drawn, true);
	assert.equal(state.hud_modes.viewsize, 110);
	assert.equal(state.hud_modes.standard_bar, false);
});

test('the ledger seeds scr_newhud from the boot launch arguments, never a lie', async () => {
	const fake = fakeEngine(oneElement);
	// boot.js forces the new HUD for the preview; the switch must show it.
	fake.engine.module.arguments = ['-manifest', 'default.fmf', '+plug_sbar', '3', '+scr_newhud', '1'];
	const bridge = new Bridge(fake);
	const state = await bridge.state();
	assert.equal(state.hud_modes.scr_newhud, 1);
	assert.equal(state.hud_modes.classic_drawn, false);
	assert.equal(state.hud_modes.new_drawn, true);
});

test('killfeed and classic-bar cvars pass the allowlist; the rest of r_ stays refused', async () => {
	const fake = fakeEngine(oneElement);
	const bridge = new Bridge(fake);
	const accepted = [
		'r_tracker 1', 'r_tracker_scale 1.5', 'r_tracker_align_right 0',
		'con_fragmessages 0', 'cl_useimagesinfraglog 1', 'cl_sbar 1', 'viewsize 110',
	];
	for (const line of accepted) {
		await bridge.send(line);
	}
	assert.deepEqual(fake.sent, accepted.map((line) => `${line}\n`));
	for (const line of ['r_speeds 1', 'r_dynamic 0', 'exec autoexec.cfg']) {
		await assert.rejects(() => bridge.send(line), (err) => {
			assert.equal(err.status, 403);
			return true;
		}, `expected refusal: ${line}`);
	}
});

test('an editor-set killfeed cvar with no imported line lands in the appended block', async () => {
	const fake = fakeEngine(oneElement);
	const bridge = new Bridge(fake);
	await bridge.state();
	bridge.captureDefaults();
	await bridge.setCvar('r_tracker', 0);
	await bridge.state();
	bridge.retainedLines = [{ raw: 'bind SPACE +jump', cvar: null, applied: false }];
	const out = bridge.exportFullCfg().trimEnd().split('\n');
	assert.deepEqual(out, [
		'bind SPACE +jump',
		'',
		'// added in ez-hud',
		'r_tracker "0"',
	]);
	// The HUD-only export stays what ezQuake's hud_export writes: hud_ cvars,
	// never the ledger's scr_/r_tracker entries.
	assert.doesNotMatch(bridge.exportHudCfg(), /r_tracker|scr_newhud/);
});

test('volume passes exactly, and never leaks into the snapshot or an export', async () => {
	const fake = fakeEngine(oneElement);
	const bridge = new Bridge(fake);

	// Exact cvar, not a prefix: the page's sound knob, and only it.
	await bridge.setCvar('volume', 0.4);
	assert.deepEqual(fake.sent, ['volume 0.4\n']);
	for (const line of ['volumefoo 1', 'vol 1']) {
		await assert.rejects(() => bridge.send(line), (err) => {
			assert.equal(err.status, 403);
			return true;
		}, `expected refusal: ${line}`);
	}

	// Editor chrome, not HUD state: a written volume must be invisible to the
	// snapshot and to both exports, or a saved config would grow a line the
	// user never wrote.
	await bridge.state();
	bridge.captureDefaults();
	await bridge.setCvar('volume', 0.7);
	await bridge.state();
	assert.equal(bridge.cvarSnapshot().has('volume'), false);
	assert.doesNotMatch(bridge.exportHudCfg(), /volume/);

	// An imported `volume "1"` line is retained verbatim, never rewritten.
	bridge.retainedLines = [{ raw: 'volume "1"', cvar: 'volume', value: '1', applied: false }];
	assert.equal(bridge.exportFullCfg(), 'volume "1"\n');
});

test('the editor-facing surface app.js needs is all present', async () => {
	const bridge = new Bridge(fakeEngine(oneElement));
	assert.equal(bridge.configured, true);
	assert.equal(Bridge.fromLocation('?t=x').configured, true);

	// No frame capture on this backend; app.js still wants an image URL whose
	// load event fires, so it gets a transparent pixel.
	assert.match(bridge.frameUrl(3), /^data:image\/gif;base64,/);
	assert.equal(await bridge.backupEnabled(), false);

	const fonts = await bridge.fonts();
	assert.equal(fonts.proportional_loaded, false);
	assert.deepEqual(fonts.available, []);

	const palette = await bridge.palette();
	assert.equal(palette.colors.length, 256);
	assert.match(palette.colors[0], /^#[0-9a-f]{6}$/);

	const configs = await bridge.configs();
	assert.equal(configs.backup_enabled, false);
	assert.deepEqual(configs.available, []);
});

// ---- killfeed cvars now speak the ezQuake dialect natively (#15 P2) --------
// The plugin's vx_tracker.c registers r_tracker/r_tracker_frags/etc. itself,
// so a plain write is a plain write: no dialect translation, no name
// collision, nothing for the adapter to do beyond the ordinary allowlist and
// ledger bookkeeping already covered above.

test('r_tracker_frags writes pass straight through, no translation or suppression', async () => {
	const fake = fakeEngine(oneElement);
	const bridge = new Bridge(fake);
	await bridge.state();
	bridge.captureDefaults();
	await bridge.send('r_tracker_frags 0');
	assert.deepEqual(fake.sent, ['r_tracker_frags 0\n']);

	const state = await bridge.state();
	assert.equal(state.killfeed.r_tracker_frags, '0');

	bridge.retainedLines = [{ raw: 'bind SPACE +jump', cvar: null, applied: false }];
	const out = bridge.exportFullCfg();
	assert.match(out, /r_tracker_frags "0"/);
});

test('loadFace goes through send, so an unlisted face name is refused the same way', async () => {
	const fake = fakeEngine(oneElement);
	const bridge = new Bridge(fake);
	await bridge.loadFace('qw-font3.otf');
	await bridge.loadFace('');
	assert.deepEqual(fake.sent, ['fontload qw-font3.otf\n', 'fontload none\n']);
	await assert.rejects(() => bridge.loadFace('a; quit'));
});
