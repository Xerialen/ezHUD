// tools/fidelity/measure.mjs — take the measurement, write the report.
//
// Both backends speak the same bridge protocol, so this file does not know
// which engine is on which end of it: real ezQuake serves /state from
// hud_web.c, the FTE-web preview serves it through tools/qa/wasm_bridge.mjs.
// The reference side is whichever one you point --reference at.
//
//   node tools/fidelity/measure.mjs \
//       --reference <origin> --reference-token <t> \
//       --preview   <origin> --preview-token   <t> \
//       [--config path.cfg] [--freeze "demo_jump 9:00"] [--tolerance 0] \
//       [--out docs/fidelity] [--date YYYY-MM-DD] [--check baseline.json]
//
// Exit 0 measured, 1 the measurement is not trustworthy or drifted from the
// baseline, 2 the inputs are not here.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { compareStates, carryClaims } from './compare.mjs';
import { renderReport } from './report.mjs';

const REPO_DIR = path.resolve(new URL('../..', import.meta.url).pathname);

export class Bridge {
	constructor(origin, token, label) {
		this.origin = origin;
		this.token = token;
		this.label = label;
	}

	url(route) {
		return `${this.origin}${route}?t=${encodeURIComponent(this.token)}`;
	}

	async state() {
		const response = await fetch(this.url('/state'), { cache: 'no-store' });
		if (!response.ok) throw new Error(`${this.label} /state HTTP ${response.status}`);
		return response.json();
	}

	async cmd(line) {
		const response = await fetch(this.url('/cmd'), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ cmd: line }),
		});
		if (!response.ok) throw new Error(`${this.label} /cmd '${line}' HTTP ${response.status}`);
	}
}

/**
 * Put both engines in the same state before reading either. Order matters:
 * freeze first so element sizes stop tracking content (ping digits, score
 * text), then apply the config, then force the layout recalculation ezHUD
 * caches — the same sequence tools/qa/matrix.mjs uses, for the same reasons.
 */
export async function settle(bridge, { configText, freeze, consoleSize }) {
	for (const line of freeze) {
		await bridge.cmd(line).catch(() => {});
	}
	if (consoleSize) {
		// Order is load-bearing, and the reason is measured rather than assumed:
		// while vid_conautoscale is non-zero the FTE-web preview derives the
		// console size from the canvas and silently ignores vid_conwidth /
		// vid_conheight (probed 2026-08-07: 'set vid_conwidth 640' left it at
		// 352x200 for the full poll). Disarm autoscale first on both engines, or
		// the two sides end up reporting rects in different units and every
		// verdict downstream is fiction. confirmConsoleSize() checks it landed.
		await bridge.cmd('set vid_conautoscale 0').catch(() => {});
		await bridge.cmd(`set vid_conwidth ${consoleSize.width}`).catch(() => {});
		await bridge.cmd(`set vid_conheight ${consoleSize.height}`).catch(() => {});
	}
	if (configText) {
		// Verbatim, deliberately. A real ezQuake config is not a list of `set`
		// lines: the owner's own config.cfg is 1575 lines of which 341 are
		// `alias`, 80 `bind`, 46 `set_tp`, and nearly every cvar line is a bare
		// `name "value"` pair. Prefixing `set` turned the command lines into
		// junk cvar writes, and it bought nothing -- a bare name and value
		// assigns in both engines. Whatever a line means, both engines are
		// handed the same one and disagree or agree on their own merits.
		for (const raw of configText.split('\n')) {
			const line = raw.trim();
			if (!line || line.startsWith('//')) continue;
			await bridge.cmd(line).catch(() => {});
		}
	}
	await bridge.cmd('hud_recalculate').catch(() => {});
}

/**
 * Wait for an engine to actually report the console size it was asked for.
 * Sending the cvars is not evidence they were honoured — see settle() — and
 * the wasm engine applies commands a frame or two after they are queued, so
 * this polls rather than reading once.
 */
export async function confirmConsoleSize(bridge, want, { attempts = 20, delayMs = 500, sleep } = {}) {
	const nap = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	let actual = { width: null, height: null };
	for (let attempt = 0; attempt < attempts; attempt++) {
		const { screen } = await bridge.state();
		actual = { width: screen?.vid_width ?? null, height: screen?.vid_height ?? null };
		if (actual.width === want.width && actual.height === want.height) return { ok: true, actual };
		await nap(delayMs);
	}
	return {
		ok: false,
		actual,
		reason: `${bridge.label ?? 'engine'} never reached the requested console size ` +
			`${want.width}x${want.height}; it is reporting ${actual.width}x${actual.height}. ` +
			'Check vid_conautoscale — while it is non-zero the console size is derived from the ' +
			'canvas and vid_conwidth/vid_conheight are ignored.',
	};
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function fileDigest(file) {
	if (!file) return null;
	try {
		return `${path.basename(file)} (sha256 ${sha256(await readFile(file)).slice(0, 16)})`;
	} catch {
		return `${file} (unreadable)`;
	}
}

function repoRevision() {
	try {
		const rev = execFileSync('git', ['-C', REPO_DIR, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
		// Tracked files only. The run writes its own report into the tree, so an
		// untracked-file check would mark every report "dirty" including because
		// of itself -- which tells the reader nothing about whether the code that
		// produced the verdicts was modified. That is the question this line
		// exists to answer.
		const dirty = execFileSync('git',
			['-C', REPO_DIR, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
		return dirty ? `${rev} (tracked files modified)` : rev;
	} catch {
		return 'unknown';
	}
}

export async function measure({
	reference, preview, configFile = null, freeze = [], consoleSize = null,
	tolerance = 0, claims = [], date, distDir = null,
}) {
	const configText = configFile ? await readFile(configFile, 'utf8') : null;

	for (const bridge of [reference, preview]) {
		await settle(bridge, { configText, freeze, consoleSize });
	}

	// Refuse before measuring, not after. A run that compares rects taken at two
	// console sizes produces a full table of confident nonsense.
	const consoleFailures = [];
	if (consoleSize) {
		for (const bridge of [reference, preview]) {
			const confirmed = await confirmConsoleSize(bridge, consoleSize);
			if (!confirmed.ok) consoleFailures.push(confirmed.reason);
		}
	}

	const snapshot = async () => ({
		reference: await reference.state(),
		preview: await preview.state(),
	});

	const first = await snapshot();
	const result = compareStates({ ...first, tolerance });

	// Two passes over an unmoved tree must judge identically (#84 acceptance 3).
	// A flaky verdict is its own defect and must not be averaged away.
	const second = await snapshot();
	const repeat = compareStates({ ...second, tolerance });
	const deterministic = JSON.stringify(result.measured) === JSON.stringify(repeat.measured);

	const carried = carryClaims(result, claims);
	const provenance = {
		'ezHUD commit': repoRevision(),
		'ezQuake build (reference)': first.reference?.engine ?? 'unknown',
		'FTE build (preview)': first.preview?.engine ?? 'unknown',
		'FTE wasm sha256': distDir ? await fileDigest(path.join(distDir, 'ftewebglcl.wasm')) : 'not recorded',
		config: (await fileDigest(configFile)) ?? 'engine defaults (no config applied)',
		demo: process.env.EZHUD_FIDELITY_DEMO
			? await fileDigest(process.env.EZHUD_FIDELITY_DEMO)
			: 'whatever each engine was already playing',
		'freeze point': freeze.length ? freeze.join(' ; ') : 'not frozen',
		// Evidence that the freeze took, on each side separately. Issuing the
		// command is not the same as the engine being frozen, and an unfrozen
		// engine makes every content-derived size a coin flip.
		'demo speed (reference / preview)':
			`${first.reference?.demo?.cl_demospeed ?? 'not reported'} / ${first.preview?.demo?.cl_demospeed ?? 'not reported'}`,
		'console size': result.comparable ? `${result.console.width}x${result.console.height}` : 'mismatched',
		'console size requested': consoleSize
			? `${consoleSize.width}x${consoleSize.height}` + (consoleFailures.length ? ' — NOT HONOURED' : '')
			: 'not set by this run',
		'tolerance': `${tolerance}px`,
		'repeated verdicts identical': deterministic ? 'yes' : 'NO — this run is not trustworthy',
	};

	return {
		result, carried, provenance, deterministic, consoleFailures,
		markdown: renderReport({ result, carried, provenance, date }),
	};
}

/** Rows only, no provenance: the part that must not change when nothing changed. */
export const baselineOf = (measurement) => ({
	measured: measurement.result.measured,
	carried: measurement.carried.map(({ element, dimension, verdict }) => ({ element, dimension, verdict })),
});

export function baselineDrift(current, baseline) {
	const key = (row) => `${row.element}/${row.dimension}`;
	const index = (rows) => new Map(rows.map((row) => [key(row), row]));
	const before = index(baseline.measured ?? []);
	const after = index(current.measured ?? []);
	const drift = [];
	for (const [name, row] of after) {
		const was = before.get(name);
		if (!was) drift.push({ row: name, from: 'absent', to: row.verdict });
		else if (was.verdict !== row.verdict || was.code !== row.code) {
			drift.push({ row: name, from: `${was.verdict}/${was.code}`, to: `${row.verdict}/${row.code}` });
		}
	}
	for (const name of before.keys()) {
		if (!after.has(name)) drift.push({ row: name, from: 'present', to: 'absent' });
	}
	return drift;
}

const invokedDirectly = process.argv[1] &&
	import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
	const args = process.argv.slice(2);
	const flag = (name, fallback = null) => {
		const i = args.indexOf(`--${name}`);
		return i >= 0 ? args[i + 1] : fallback;
	};

	const referenceOrigin = flag('reference');
	const previewOrigin = flag('preview');
	if (!referenceOrigin || !previewOrigin) {
		console.error('usage: measure.mjs --reference <origin> --reference-token <t> --preview <origin> --preview-token <t>');
		process.exit(2);
	}

	const consoleFlag = flag('console');
	const measurement = await measure({
		reference: new Bridge(referenceOrigin, flag('reference-token', ''), 'reference'),
		preview: new Bridge(previewOrigin, flag('preview-token', ''), 'preview'),
		configFile: flag('config'),
		freeze: (flag('freeze') ?? '').split(';').map((s) => s.trim()).filter(Boolean),
		consoleSize: consoleFlag
			? { width: Number(consoleFlag.split('x')[0]), height: Number(consoleFlag.split('x')[1]) }
			: null,
		tolerance: Number(flag('tolerance', '0')),
		claims: JSON.parse(await readFile(flag('claims', new URL('./claims.json', import.meta.url)), 'utf8')),
		date: flag('date') ?? new Date().toISOString().slice(0, 10),
		distDir: flag('dist'),
	});

	const outDir = flag('out', path.join(REPO_DIR, 'docs/fidelity'));
	const stem = path.join(outDir, `${flag('date') ?? new Date().toISOString().slice(0, 10)}-fidelity`);
	await mkdir(outDir, { recursive: true });
	await writeFile(`${stem}.md`, measurement.markdown);
	await writeFile(`${stem}.json`, JSON.stringify(baselineOf(measurement), null, 1) + '\n');

	const { result } = measurement;
	console.log(result.comparable
		? `${result.counts.diverging} diverging, ${result.counts.matching} matching, ` +
			`${result.counts.not_assessable} not assessable across ${result.counts.elements} elements`
		: `NOT COMPARABLE: ${result.incomparable_reason}`);
	console.log(`report: ${stem}.md`);

	let failed = false;
	if (!result.comparable) {
		console.error('FIDELITY ERROR: the two snapshots are not comparable; no verdicts were produced.');
		failed = true;
	}
	for (const reason of measurement.consoleFailures) {
		console.error(`FIDELITY ERROR: ${reason}`);
		failed = true;
	}
	if (!measurement.deterministic) {
		console.error('FIDELITY ERROR: two consecutive reads judged differently. Freeze the demo and re-run.');
		failed = true;
	}
	const baselineFile = flag('check');
	if (baselineFile) {
		const drift = baselineDrift(baselineOf(measurement), JSON.parse(await readFile(baselineFile, 'utf8')));
		if (drift.length) {
			console.error(`FIDELITY DRIFT: ${drift.length} row(s) changed verdict against ${baselineFile}:`);
			for (const entry of drift) console.error(`  ${entry.row}: ${entry.from} -> ${entry.to}`);
			failed = true;
		} else {
			console.log(`no drift against ${baselineFile}`);
		}
	}
	process.exit(failed ? 1 : 0);
}
