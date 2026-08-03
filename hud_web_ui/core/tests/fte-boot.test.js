import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { Bridge } from '../fte-adapter.js';

const bootSource = readFileSync(new URL('../../fte/boot.js', import.meta.url), 'utf8');

function fakeModule(elements, label = '') {
	const state = { protocol: 1, elements };
	return {
		label,
		canvas: { width: 640, height: 360 },
		arguments: [],
		stateCalls: 0,
		_EZHud_StateJSON() {
			this.stateCalls += 1;
			return 1;
		},
		UTF8ToString: () => JSON.stringify(state),
	};
}

function fakeFTEC(label = '') {
	return {
		label,
		sent: [],
		handleevent() {},
		cbufadd(line) { this.sent.push(line); },
	};
}

function loadBoot() {
	let now = 0;
	let interval = null;
	let intervalActive = false;
	const warnings = [];
	const listeners = new Map();
	const storage = new Map();
	const status = { textContent: '', hidden: true };
	const canvas = { width: 1920, height: 1080 };
	const frame = { dispatchEvent() {} };

	const window = {
		localStorage: {
			getItem: (key) => storage.get(key) ?? null,
			setItem: (key, value) => storage.set(key, String(value)),
		},
		addEventListener(type, listener) {
			const current = listeners.get(type) ?? [];
			current.push(listener);
			listeners.set(type, current);
		},
		removeEventListener() {},
		dispatchEvent(event) {
			for (const listener of listeners.get(event.type) ?? []) {
				listener.call(window, event);
			}
			return true;
		},
	};
	window.window = window;

	const document = {
		head: { appendChild() {} },
		getElementById(id) {
			return { canvas, frame, 'fte-status': status }[id] ?? null;
		},
		createElement() {
			return { addEventListener() {}, charset: '', src: '' };
		},
		removeEventListener() {},
	};

	class FakeEvent {
		constructor(type) { this.type = type; }
	}

	const context = vm.createContext({
		window,
		document,
		console: {
			log() {},
			warn(message) { warnings.push(message); },
		},
		Date: { now: () => now },
		Event: FakeEvent,
		CustomEvent: FakeEvent,
		setTimeout() { return 1; },
		setInterval(callback) {
			interval = callback;
			intervalActive = true;
			return 1;
		},
		clearInterval() { intervalActive = false; },
	});
	vm.runInContext(bootSource, context, { filename: 'hud_web_ui/fte/boot.js' });

	return {
		window,
		status,
		warnings,
		setNow(value) { now = value; },
		tick() {
			assert.ok(interval, 'boot installed its watchdog');
			interval();
		},
		get intervalActive() { return intervalActive; },
	};
}

test('boot consumers resolve Module and FTEC again after both globals are swapped', () => {
	const page = loadBoot();
	const oldModule = fakeModule([], 'old');
	const oldFTEC = fakeFTEC('old');
	page.window.Module = oldModule;
	page.window.FTEC = oldFTEC;
	page.tick();

	const nextModule = fakeModule([], 'next');
	const nextFTEC = fakeFTEC('next');
	page.window.Module = nextModule;
	page.window.FTEC = nextFTEC;

	assert.equal(page.window.EZHUD_FTE.engine().module, nextModule);
	assert.equal(page.window.EZHUD_FTE.engine().ftec, nextFTEC);
	assert.equal(page.window.EZHUD_FTE.play('qw/demos/next.mvd'), true);
	assert.deepEqual(nextFTEC.sent, ['playdemo demos/next.mvd\n']);
	assert.deepEqual(oldFTEC.sent, []);

	page.tick();
	assert.equal(oldModule.stateCalls, 1);
	assert.equal(nextModule.stateCalls, 1);
});

test('the watchdog dispatches and warns exactly once for each live FTEC swap', () => {
	const page = loadBoot();
	let replacements = 0;
	page.window.addEventListener('ezhud:engine-replaced', () => { replacements += 1; });
	page.window.Module = fakeModule([]);
	page.window.FTEC = fakeFTEC('first');
	page.tick();

	page.window.Module = fakeModule([]);
	page.window.FTEC = fakeFTEC('second');
	page.tick();
	page.tick();
	assert.equal(replacements, 1);
	assert.equal(page.warnings.length, 1);

	page.window.Module = fakeModule([]);
	page.window.FTEC = fakeFTEC('third');
	page.tick();
	page.tick();
	assert.equal(replacements, 2);
	assert.equal(page.warnings.length, 2);
});

test('a HUD drawn by the live replacement clears the stale retry status', () => {
	const page = loadBoot();
	page.window.Module = fakeModule([]);
	page.window.FTEC = fakeFTEC('old');
	page.setNow(8500);
	page.tick();
	assert.match(page.status.textContent, /No HUD drawn yet/);
	assert.equal(page.status.hidden, false);

	page.window.Module = fakeModule([{ rect: { x: 1, y: 2, w: 3, h: 4 } }]);
	page.window.FTEC = fakeFTEC('live');
	page.setNow(9000);
	page.tick();

	assert.equal(page.status.textContent, '');
	assert.equal(page.status.hidden, true);
	assert.equal(page.intervalActive, false);
});

test('the retry status becomes an honest failure after another ten seconds', () => {
	const page = loadBoot();
	page.window.Module = fakeModule([]);
	page.window.FTEC = fakeFTEC();
	page.setNow(8500);
	page.tick();
	page.setNow(18501);
	page.tick();
	assert.match(page.status.textContent, /no HUD was drawn after retrying the demo/i);
});

test('the adapter drops an injected handle when boot reports a replacement', async () => {
	const saved = new Map([
		['addEventListener', Object.getOwnPropertyDescriptor(globalThis, 'addEventListener')],
		['Module', Object.getOwnPropertyDescriptor(globalThis, 'Module')],
		['FTEC', Object.getOwnPropertyDescriptor(globalThis, 'FTEC')],
	]);
	const listeners = new Map();
	try {
		globalThis.addEventListener = (type, listener) => listeners.set(type, listener);
		const oldModule = fakeModule([]);
		const oldFTEC = fakeFTEC('old');
		const bridge = new Bridge({ engine: { module: oldModule, ftec: oldFTEC } });

		const nextModule = fakeModule([{ rect: { x: 0, y: 0, w: 1, h: 1 } }]);
		const nextFTEC = fakeFTEC('next');
		globalThis.Module = nextModule;
		globalThis.FTEC = nextFTEC;
		listeners.get('ezhud:engine-replaced')?.({ type: 'ezhud:engine-replaced' });

		await bridge.state();
		await bridge.send('hud_recalculate');
		assert.equal(oldModule.stateCalls, 0);
		assert.deepEqual(oldFTEC.sent, []);
		assert.equal(nextModule.stateCalls, 1);
		assert.deepEqual(nextFTEC.sent, ['hud_recalculate\n']);
	} finally {
		for (const [name, descriptor] of saved) {
			if (descriptor) {
				Object.defineProperty(globalThis, name, descriptor);
			} else {
				delete globalThis[name];
			}
		}
	}
});
