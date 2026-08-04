// tools/qa/matrix.mjs — the golden matrix runner.
//
//   node tools/qa/matrix.mjs --bridge <origin> --token <t> [--cells <k,k>] [--artifacts dir]
//   node tools/qa/matrix.mjs --fake [--fault <element>] ...
//
// Every cell: load master cfg -> snapshot -> apply cell cvars -> resize ->
// snapshot -> judge invariants -> resize back (metamorphic) -> export ->
// reimport into a reset session -> judge round-trip. Artifacts per cell:
// state snapshots at each checkpoint, the invariant report with the numbers,
// the exported cvars, and the engine request log. Exit 1 if any hard
// invariant fails; the review agent works from the artifact dir alone.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
	alignment, containment, hudCvars, metamorphic, nonVacuous, proportionality, roundTrip,
} from './invariants.mjs';

// Golden cfg text: the exported cvars, sorted, one per line — deterministic so
// a diff against tools/qa/golden/<cell>/expected.cfg is meaningful.
export function goldenText(cvars) {
	return Object.keys(cvars).sort().map((k) => `${k} ${cvars[k]}`).join('\n') + '\n';
}

const KILLFEED = {
	classic:   { r_tracker: '0', con_fragmessages: '1', cl_useimagesinfraglog: '0' },
	modern:    { r_tracker: '1', con_fragmessages: '0', cl_useimagesinfraglog: '1' },
	separated: { r_tracker: '1', con_fragmessages: '1', cl_useimagesinfraglog: '1' },
};
const HUD_STYLE = {
	newhud:  { scr_newhud: '1' },
	classic: { scr_newhud: '0' },
};
const RESOLUTIONS = {
	'1440-1080': { from: [2560, 1440], to: [1920, 1080] },
	'1440-720':  { from: [2560, 1440], to: [1280, 720] },
};

export function allCells() {
	const cells = [];
	for (const hud of Object.keys(HUD_STYLE)) {
		for (const killfeed of Object.keys(KILLFEED)) {
			for (const resolution of Object.keys(RESOLUTIONS)) {
				cells.push({ key: `${hud}.${killfeed}.${resolution}`, hud, killfeed, resolution });
			}
		}
	}
	return cells;
}

class Engine {
	constructor(origin, token) {
		this.origin = origin;
		this.token = token;
	}

	url(route) {
		return `${this.origin}${route}?t=${encodeURIComponent(this.token)}`;
	}

	async state() {
		const response = await fetch(this.url('/state'), { cache: 'no-store' });
		if (!response.ok) throw new Error(`/state HTTP ${response.status}`);
		return response.json();
	}

	async log() {
		try {
			const response = await fetch(this.url('/log'));
			return response.ok ? await response.text() : '';
		} catch {
			return '';
		}
	}

	// Advisory screenshot layer; null when the backend has no framebuffer.
	async frame() {
		try {
			const response = await fetch(`${this.origin}/frame.png?t=${encodeURIComponent(this.token)}&n=qa`);
			if (!response.ok) return null;
			return Buffer.from(await response.arrayBuffer());
		} catch {
			return null;
		}
	}

	async cmd(line) {
		const response = await fetch(this.url('/cmd'), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ cmd: line }),
		});
		if (!response.ok) throw new Error(`/cmd '${line}' HTTP ${response.status}`);
	}

	async apply(cvars) {
		for (const [name, value] of Object.entries(cvars)) {
			await this.cmd(`set ${name} ${value}`);
		}
	}

	async applyCfg(text) {
		for (const raw of text.split('\n')) {
			const line = raw.trim();
			if (!line || line.startsWith('//')) continue;
			await this.cmd(`set ${line}`);
		}
	}

	async resize([width, height]) {
		await this.cmd(`set vid_width ${width}`);
		await this.cmd(`set vid_height ${height}`);
	}
}

export async function runCell(engine, cell, { masterCfg, artifactsDir, goldenDir = null, updateGolden = false }) {
	const dir = path.join(artifactsDir, cell.key);
	await mkdir(dir, { recursive: true });
	const save = (file, data) => writeFile(path.join(dir, file),
		typeof data === 'string' ? data : JSON.stringify(data, null, 1));

	const { from, to } = RESOLUTIONS[cell.resolution];
	await engine.resize(from);
	// Freeze the demo so element sizes stop tracking content (ping digits,
	// score text) — without this the metamorphic check measures the game, not
	// the layout. Backends without the command just refuse it; that is fine.
	await engine.cmd('demo_setspeed 0').catch(() => {});
	await engine.applyCfg(masterCfg);
	await engine.apply(HUD_STYLE[cell.hud]);
	await engine.apply(KILLFEED[cell.killfeed]);

	const source = await engine.state();
	await save('1-source.json', source);

	await engine.resize(to);
	const resized = await engine.state();
	await save('2-resized.json', resized);

	const reports = [
		nonVacuous(source, { min: 10 }),
		proportionality(source, resized),
		containment(resized),
		alignment(source, resized),
	];

	// There and back again: exact reproduction, no golden needed.
	await engine.resize(from);
	const returned = await engine.state();
	await save('3-returned.json', returned);
	reports.push(metamorphic(source, returned));

	// Export/import: the exported hud_* cvars, re-applied, must round-trip
	// byte-identically (string rule from EZHud_StateJSON).
	const exported = hudCvars(returned);
	await save('4-exported.json', exported);
	await engine.apply(exported);
	const reimported = hudCvars(await engine.state());
	reports.push(roundTrip(exported, reimported));

	// Golden cfg layer: hard-fails on drift once a golden is blessed; blessing
	// is the explicit --update-golden action, reviewed in git.
	const advisories = [];
	if (goldenDir) {
		const goldenPath = path.join(goldenDir, cell.key, 'expected.cfg');
		const actual = goldenText(exported);
		await save('exported.cfg', actual);
		if (updateGolden) {
			await mkdir(path.dirname(goldenPath), { recursive: true });
			await writeFile(goldenPath, actual);
		} else {
			const expected = await readFile(goldenPath, 'utf8').catch(() => null);
			if (expected === null) {
				advisories.push({ name: 'golden-cfg', note: 'no golden blessed for this cell yet (--update-golden)' });
			} else {
				reports.push({
					name: 'golden-cfg',
					pass: expected === actual,
					failures: expected === actual ? [] : [{ diff: 'exported.cfg differs from golden expected.cfg' }],
				});
			}
		}
	}

	// Screenshot layer is advisory and real-engine only: the fake has no
	// framebuffer, and rects already hard-fail placement.
	const frame = await engine.frame();
	if (frame) {
		await writeFile(path.join(dir, 'frame.png'), frame);
	} else {
		advisories.push({ name: 'screenshot', note: 'no /frame.png from this backend' });
	}

	// Engine-log shape: rejected commands or errors during a cell need eyes
	// even when geometry passed.
	const engineLog = await engine.log();
	const suspicious = engineLog.split('\n').filter((l) => /rejected|error/i.test(l));
	if (suspicious.length) {
		advisories.push({ name: 'engine-log', note: 'suspicious engine log lines', lines: suspicious });
	}

	await save('report.json', {
		cell: cell.key,
		pass: reports.every((r) => r.pass),
		reports,
		advisories,
	});
	await save('engine.log', engineLog);
	return { cell: cell.key, pass: reports.every((r) => r.pass), reports, advisories };
}

const invokedDirectly = process.argv[1] &&
	import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
	const args = process.argv.slice(2);
	const flag = (name) => {
		const i = args.indexOf(`--${name}`);
		return i >= 0 ? args[i + 1] : null;
	};
	const artifactsDir = flag('artifacts') ??
		path.join('tools/qa/artifacts', new Date().toISOString().replace(/[:.]/g, '-'));
	const only = flag('cells')?.split(',');

	let engine;
	let fake = null;
	if (args.includes('--fake')) {
		const { startFakeEngine } = await import('./fake_engine.mjs');
		fake = await startFakeEngine({ fault: flag('fault') });
		engine = new Engine(fake.origin, fake.token);
	} else {
		const origin = flag('bridge');
		const token = flag('token');
		if (!origin || !token) {
			console.error('usage: matrix.mjs --bridge <origin> --token <t> | --fake [--fault el]');
			process.exit(2);
		}
		engine = new Engine(origin, token);
	}

	const masterPath = flag('master') ?? new URL('./golden/master_1440p.cfg', import.meta.url);
	const masterCfg = await readFile(masterPath, 'utf8');
	const goldenDir = new URL('./golden', import.meta.url).pathname;
	const updateGolden = args.includes('--update-golden');
	const determinism = args.includes('--determinism');
	const cells = allCells().filter((c) => !only || only.includes(c.key));
	let failed = 0;
	for (const cell of cells) {
		const result = await runCell(engine, cell, { masterCfg, artifactsDir, goldenDir, updateGolden });
		if (determinism) {
			// Two consecutive runs must judge identically; a flaky cell is a
			// defect class of its own (plan B6).
			const again = await runCell(engine, cell,
				{ masterCfg, artifactsDir: path.join(artifactsDir, 'rerun'), goldenDir });
			if (JSON.stringify(again.reports) !== JSON.stringify(result.reports)) {
				result.pass = false;
				result.reports.push({ name: 'determinism', pass: false,
					failures: [{ note: 'second run produced a different invariant report' }] });
			}
		}
		const verdict = result.pass ? 'PASS' : 'FAIL';
		if (!result.pass) failed++;
		const notes = result.advisories.length
			? ` (advisory: ${result.advisories.map((a) => a.name).join(', ')})` : '';
		console.log(`${verdict} ${cell.key}` + (result.pass ? notes :
			` — ${result.reports.filter((r) => !r.pass).map((r) => r.name).join(', ')}${notes}`));
	}
	console.log(`${cells.length - failed}/${cells.length} cells passed; artifacts in ${artifactsDir}`);
	if (fake) await fake.close();
	process.exit(failed ? 1 : 0);
}
