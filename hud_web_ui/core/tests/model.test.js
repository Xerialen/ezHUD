import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
	Model, Status, colorAllowsNames, formatColor, isColorParam, needsRecalculate,
	parseColor, resizeTo, resizedRect,
} from '../model.js';

const fixture = JSON.parse(await readFile(
	new URL('../../fixtures/state.json', import.meta.url), 'utf8'));
const clone = (value) => structuredClone(value);

test('applyState treats a non-null rect as drawn and suppresses identical polls', () => {
	const model = new Model();
	let emissions = 0;
	model.subscribe(() => emissions++);
	model.applyState(clone(fixture));
	assert.equal(model.status, Status.LIVE);
	assert.equal(model.placedElements.length, 25);
	assert.equal(model.version, 1);
	model.applyState(clone(fixture));
	assert.equal(model.version, 1);
	assert.equal(emissions, 1);

	const idle = clone(fixture);
	idle.elements.forEach((e) => { e.rect = null; });
	model.applyState(idle);
	assert.equal(model.status, Status.IDLE);
});

test('applyError distinguishes expired links and permits an identical recovery state', () => {
	const model = new Model();
	model.applyState(clone(fixture));
	model.applyError({ status: 403 });
	assert.equal(model.status, Status.DENIED);
	model.applyState(clone(fixture));
	assert.equal(model.status, Status.LIVE);
	assert.equal(model.version, 2);
	model.applyError({ status: 0 });
	assert.equal(model.status, Status.LOST);
});

test('box resize learns the cvar-to-rect transfer ratio from engine geometry', () => {
	assert.deepEqual(resizeTo({
		mode: 'box', width: 50, height: 20,
		widthCvar: 'hud_bar_health_width', heightCvar: 'hud_bar_health_height',
	}, { x: 74, y: 198, w: 100, h: 60 }, 20, 30), [
		['hud_bar_health_width', 60],
		['hud_bar_health_height', 30],
	]);
});

test('uniform scale follows the strongest relative axis and stays bounded', () => {
	assert.deepEqual(resizeTo(
		{ mode: 'scale', scale: 2, cvar: 'hud_face_scale' },
		{ x: 0, y: 0, w: 40, h: 20 }, 4, 10,
	), [['hud_face_scale', 3]]);
	assert.deepEqual(resizeTo(
		{ mode: 'scale', scale: 1, cvar: 'hud_face_scale' },
		{ x: 0, y: 0, w: 40, h: 20 }, -100, -100,
	), [['hud_face_scale', 0.05]]);
});

test('resizedRect preserves the edge or centre selected by engine alignment', () => {
	assert.deepEqual(
		resizedRect({ x: 10, y: 20, w: 11, h: 9 }, { x: 'right', y: 'center' }, 6, 4),
		{ x: 15, y: 22, w: 6, h: 4 },
	);
});

test('percentage dimensions refuse resize handles instead of becoming pixels', () => {
	const model = new Model();
	const radar = clone(fixture.elements.find((e) => e.name === 'radar'));
	radar.rect = { x: 9, y: 11, w: 96, h: 50 };
	radar.cvars.hud_radar_width = '30%';
	radar.cvars.hud_radar_height = '25%';
	const control = model.sizeControl(radar);
	assert.equal(control.mode, 'relative');
	assert.match(control.reason, /percentage/);
	assert.deepEqual(model.resizeHandles(radar), []);
});

test('resize handles expose centred gain without inventing a shared axis rule', () => {
	const model = new Model();
	const face = clone(fixture.elements.find((e) => e.name === 'face'));
	face.align_x = 'center';
	face.align_y = 'top';
	const handles = model.resizeHandles(face);
	assert.equal(handles.find((h) => h.id === 'se').gainX, 2);
	assert.equal(handles.find((h) => h.id === 'se').gainY, 1);
	assert.equal(handles.find((h) => h.id === 'se').active, true);
});

test('colour parsing follows Q_atoi token and byte behavior', () => {
	const palette = Array.from({ length: 256 }, (_, i) => `#${i.toString(16).padStart(2, '0')}0000`);
	assert.deepEqual(parseColor('256', palette), {
		form: 'index', index: 0, hex: '#000000', alpha: 255, valid: true, note: undefined,
	});
	assert.deepEqual(parseColor('0xff', palette).index, 255);
	assert.deepEqual(parseColor('1.9 99', palette).index, 1);
	assert.equal(parseColor('RED', palette, { allowNames: true }).index, 0);
	assert.deepEqual(parseColor('-1 256 257 258').hex, '#ff0001');
	assert.equal(parseColor('-1 256 257 258').alpha, 2);
	assert.equal(parseColor('red', palette, { allowNames: true }).hex, '#ff0000');
	assert.equal(formatColor({ form: 'rgba', hex: '#12ab00', alpha: 7 }), '18 171 0 7');
});

test('cvar derivation recognizes only the engine rules', () => {
	assert.equal(colorAllowsNames('frame_color'), true);
	assert.equal(colorAllowsNames('text_color'), false);
	assert.equal(isColorParam('color_normal'), true);
	assert.equal(isColorParam('item_colour'), true);
	assert.equal(needsRecalculate('hud_face_align_y'), true);
	assert.equal(needsRecalculate('hud_face_pos_y'), false);
});

test('inline state covers fonts, view, hud modes, and registered defaults', () => {
	const model = new Model();
	model.applyState({
		protocol: 1,
		screen: { vid_width: 320, vid_height: 200, scr_con_current: 0 },
		physical: [1280, 720],
		fonts: { proportional_loaded: false, facepath: 'missing.otf' },
		view: { spectator: true, tracking: false },
		hud_modes: {
			new_drawn: true, classic_drawn: true, standard_bar: false,
			scr_newhud: 2, cl_hud: true, cl_sbar: false, scr_compacthud: 0, viewsize: 90,
		},
		elements: [{
			name: 'sample', shown: true, place: 'screen', align_x: 'left', align_y: 'top',
			pos_x: 7, pos_y: 0, spec_required: false, needs_pov: true, rect: null, cvars: {},
			defaults: { show: '1', place: 'screen', align_x: 'left', align_y: 'top', pos_x: '0', pos_y: '0' },
		}],
	});
	assert.match(model.inertReason('proportional'), /missing\.otf/);
	assert.equal(model.reasonUnplaced(model.elements[0]), 'Needs a player POV. Track someone instead of free-flying.');
	assert.match(model.modeSummary, /new HUD.*classic bar.*QW262/);
	assert.equal(model.sbarInert, true);
	assert.deepEqual(model.resetChanges, [{
		name: 'sample', fields: [{ field: 'pos_x', from: '7', to: '0' }],
	}]);
});

test('killfeed derivation: absence is unknown, and the three canonical combos read right', () => {
	const model = new Model();
	const base = {
		protocol: 1,
		screen: { vid_width: 320, vid_height: 200, scr_con_current: 0 },
		elements: [],
	};

	// No block at all: the engine does not expose it, which is not "off".
	model.applyState(structuredClone(base));
	assert.equal(model.killfeed, null);
	assert.equal(model.killfeedSummary, '');

	const withFeed = (r_tracker, con_fragmessages, cl_useimagesinfraglog) => {
		const state = structuredClone(base);
		state.killfeed = {
			r_tracker, con_fragmessages, cl_useimagesinfraglog,
			r_tracker_time: '4', r_tracker_frags: '1',
		};
		model.applyState(state);
		return model;
	};

	// Dedicated feed with weapon icons.
	withFeed('1', '0', '1');
	assert.equal(model.killfeed.r_tracker, '1');
	assert.match(model.killfeedSummary, /dedicated tracker \(weapon icons\)\.$/);
	assert.doesNotMatch(model.killfeedSummary, /console/);

	// Console-only classic obituaries.
	withFeed('0', '1', '0');
	assert.match(model.killfeedSummary, /only among console messages \(classic text obituaries\)/);

	// Both at once.
	withFeed('1', '1', '1');
	assert.match(model.killfeedSummary, /dedicated tracker \(weapon icons\), and also to the console/);

	// Neither: still a sentence, not silence.
	withFeed('0', '0', '0');
	assert.match(model.killfeedSummary, /nowhere/);
});

test('placement options refuse self/descendant cycles with a stated reason', () => {
	const model = new Model();
	const element = (name, parent = null) => ({
		name, shown: true, place: parent ? `@${parent}` : 'screen', parent,
		align_x: 'left', align_y: 'top', pos_x: '0', pos_y: '0', order: '0', frame: '0',
		spec_required: false, needs_pov: false, rect: { x: 0, y: 0, w: 10, h: 10 }, cvars: {},
	});
	model.applyState({
		protocol: 1,
		screen: { vid_width: 320, vid_height: 200, scr_con_current: 0 },
		physical: [1280, 720],
		elements: [element('parent'), element('child', 'parent'), element('grandchild', 'child')],
	});

	assert.match(model.placementRefusal('parent', '@parent'), /itself/);
	assert.match(model.placementRefusal('parent', '@child'), /cycle/);
	assert.match(model.placementRefusal('parent', 'grandchild'), /cycle/);
	assert.equal(model.placementRefusal('grandchild', '@parent'), null);
	assert.equal(model.placementRefusal('parent', 'screen'), null);

	const options = model.placeOptions('parent');
	for (const value of ['parent', '@parent', 'child', '@child', 'grandchild', '@grandchild']) {
		const option = options.find((entry) => entry.value === value);
		assert(option, `missing placement option ${value}`);
		assert.equal(option.disabled, true, `${value} should be disabled`);
		assert.match(option.reason, value.includes('parent') ? /itself/ : /cycle/);
	}
	assert.equal(options.find((entry) => entry.value === '@grandchild').label.includes('unavailable'), true);
});

test('save derivation checks the active directory listing and safe names', () => {
	const model = new Model();
	model.applyConfigs({
		main: 'config.cfg', config_dir: '/full', export_dir: '/hud',
		available: ['config.cfg'], exports: ['minimal.cfg'],
	});
	assert.equal(model.saveFile, 'config.cfg');
	assert.equal(model.saveOverwrites, true);
	model.setSave({ hudOnly: true, name: 'minimal.cfg' });
	assert.equal(model.saveDirectory, '/hud');
	assert.equal(model.saveOverwrites, true);
	model.setSave({ name: '../escape' });
	assert.match(model.saveNameError, /no spaces or slashes/);
});
