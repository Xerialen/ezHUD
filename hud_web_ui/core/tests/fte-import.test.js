// The pure half of the FTE host page's import pipeline: line parsing and the
// apply allowlist. It lives here rather than under fte/ because tier1 runs
// core/tests/*.test.js, and a parser that decides what to do with someone
// else's whole config is not something to leave untested.

import assert from 'node:assert/strict';
import test from 'node:test';

import { appliable, importCfg, parseCfgLine } from '../../fte/import.js';

test('parseCfgLine reads the three assignment forms', () => {
	assert.deepEqual(parseCfgLine('hud_health_pos_x 12'), { cvar: 'hud_health_pos_x', value: '12' });
	assert.deepEqual(parseCfgLine('set hud_health_pos_x 12'), { cvar: 'hud_health_pos_x', value: '12' });
	assert.deepEqual(parseCfgLine('seta hud_health_pos_x 12'), { cvar: 'hud_health_pos_x', value: '12' });
	assert.deepEqual(parseCfgLine('  seta   HUD_Health_Pos_X   12  '), { cvar: 'hud_health_pos_x', value: '12' });
});

test('parseCfgLine unquotes values and keeps their spaces', () => {
	assert.deepEqual(parseCfgLine('hud_clock_format "%H:%M %p"'), { cvar: 'hud_clock_format', value: '%H:%M %p' });
	assert.deepEqual(parseCfgLine('set hud_clock_format ""'), { cvar: 'hud_clock_format', value: '' });
});

test('parseCfgLine returns null for everything that is not an assignment', () => {
	for (const line of ['', '   ', '// a comment', '//hud_health_pos_x 12', 'hud_recalculate', 'toggleconsole']) {
		assert.equal(parseCfgLine(line), null, JSON.stringify(line));
	}
});

test('parseCfgLine drops a trailing comment but not a // inside quotes', () => {
	assert.deepEqual(parseCfgLine('hud_health_pos_x 12 // was 4'), { cvar: 'hud_health_pos_x', value: '12' });
	assert.deepEqual(parseCfgLine('hud_tracking_format "//x"'), { cvar: 'hud_tracking_format', value: '//x' });
});

test('appliable covers hud_ and the con-size family, and never hud_web', () => {
	for (const name of ['hud_health_pos_x', 'hud_recalculate', 'scr_newhud', 'cl_sbar',
		'vid_conwidth', 'vid_conheight', 'vid_conautoscale']) {
		assert.equal(appliable(name), true, name);
	}
	for (const name of ['hud_web', 'hud_web_port', 'bind', 'alias', 'cl_maxfps', 'name', '', null]) {
		assert.equal(appliable(name), false, String(name));
	}
});

// ---- the whole pipeline, against a fake adapter -----------------------------

function fakeBridge() {
	const state = {
		protocol: 1,
		screen: { vid_width: 512, vid_height: 288 },
		elements: [{
			name: 'health', shown: true, place: 'screen', parent: null,
			align_x: 'left', align_y: 'top', pos_x: 0, pos_y: 0, order: 5, frame: 0,
			rect: { x: 4, y: 4, w: 45, h: 20 },
			cvars: { hud_health_scale: '1', hud_health_style: '0' },
		}],
	};
	return {
		state,
		applied: [],
		sent: [],
		retainedLines: [],
		importedName: null,
		defaults: null,
		async state_() { return state; },
		cvarSnapshot() {
			const out = new Map();
			for (const e of state.elements) {
				for (const [k, v] of Object.entries(e.cvars)) { out.set(k, v); }
				out.set(`hud_${e.name}_pos_x`, String(e.pos_x));
			}
			return out;
		},
		captureDefaults() { this.defaults = this.cvarSnapshot(); },
		async setCvar(name, value) {
			// The adapter's refusals, as far as this pipeline can see them.
			if (name.startsWith('hud_web') || /[;\r\n$]/.test(`${name} ${value}`)) {
				throw new Error('command not permitted');
			}
			this.applied.push([name, value]);
		},
		async send(cmd) { this.sent.push(cmd); },
	};
}

test('importCfg applies what it can, retains the rest in file order, and recalculates', async () => {
	const bridge = fakeBridge();
	bridge.state = async () => bridge.state_();
	const text = [
		'// my config',
		'bind SPACE +jump',
		'seta hud_health_scale 2',
		'scr_newhud 1',
		'cl_maxfps 77',
		'',
	].join('\n');

	const report = await importCfg(text, 'mine.cfg', bridge);

	assert.deepEqual(bridge.applied, [['hud_health_scale', '2'], ['scr_newhud', '1']]);
	assert.deepEqual(bridge.sent, ['hud_recalculate']);
	assert.equal(bridge.importedName, 'mine.cfg');
	// The trailing newline must not become a sixth retained line, or the file
	// grows a blank line on every round trip.
	assert.deepEqual(bridge.retainedLines.map((l) => l.raw), [
		'// my config', 'bind SPACE +jump', 'seta hud_health_scale 2', 'scr_newhud 1', 'cl_maxfps 77',
	]);
	assert.deepEqual(bridge.retainedLines.map((l) => l.applied), [false, false, true, true, false]);
	assert.equal(report.applied, 2);

	// Defaults are the pre-import values: hud_health_scale was 1 in the state.
	assert.equal(bridge.defaults.get('hud_health_scale'), '1');
});

test('the drift report names elements FTE does not register and cvars it never reports back', async () => {
	const bridge = fakeBridge();
	bridge.state = async () => bridge.state_();
	const text = [
		'hud_health_pos_x 10',      // fine
		'hud_ping_pos_x 10',        // ping is not registered here
		'hud_ping_align_x right',
		'scr_newhud 1',             // applied, but nothing reports it back
		'hud_web 1',                // never even attempted: off the apply list
		'hud_health_style $x',      // attempted, and refused by the adapter
		'bind SPACE +jump',
	].join('\n');

	const report = await importCfg(text, 'drift.cfg', bridge);

	assert.deepEqual(report.missingElements, [{ name: 'ping', cvars: ['hud_ping_pos_x', 'hud_ping_align_x'] }]);
	// hud_ping_* is missing an element, which is already the reason; saying it
	// again here would read as a second, separate problem.
	assert.deepEqual(report.unpreviewed, ['scr_newhud']);
	assert.deepEqual(report.refused, [{ cvar: 'hud_health_style', reason: 'command not permitted' }]);
	// Both unapplied hud_ lines are named rather than disappearing into a count.
	assert.deepEqual(report.retainedHud, ['hud_web 1', 'hud_health_style $x']);
	assert.equal(report.retained, 3); // the two above, plus the bind
});
