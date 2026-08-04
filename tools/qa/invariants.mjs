// tools/qa/invariants.mjs — the "expected output" half of every matrix cell.
//
// Pure functions over /state snapshots: no HTTP, no filesystem, so they are
// unit-testable and the same code judges the fake engine, the wasm engine, and
// a native build. Each evaluator returns { name, pass, failures: [...] } where
// every failure carries the numbers, because the review agent works from the
// artifact alone.

// After a resize, every rect must scale by the resolution ratio, within one
// glyph (8px at the element's scale) — the engine lays out in integers, so
// exactness is not on offer, but drift beyond a character cell is a bug.
export function proportionality(before, after, { name = 'proportionality' } = {}) {
	const rx = after.screen.vid_width / before.screen.vid_width;
	const ry = after.screen.vid_height / before.screen.vid_height;
	const failures = [];
	const byName = new Map(after.elements.map((e) => [e.name, e]));

	for (const b of before.elements) {
		const a = byName.get(b.name);
		if (!b.rect || !a?.rect) continue;
		const scale = Number(b.cvars?.[`hud_${b.name}_scale`] ?? 1) || 1;
		const tolerance = Math.max(8 * scale, 1);
		const expected = {
			x: b.rect.x * rx, y: b.rect.y * ry,
			w: b.rect.w * rx, h: b.rect.h * ry,
		};
		const deltas = Object.fromEntries(
			Object.entries(expected).map(([k, v]) => [k, Math.abs(a.rect[k] - v)]));
		if (Object.values(deltas).some((d) => d > tolerance)) {
			failures.push({ element: b.name, before: b.rect, after: a.rect, expected, deltas, tolerance });
		}
	}
	return { name, pass: failures.length === 0, failures };
}

// Every drawn rect stays inside the screen.
export function containment(state, { name = 'containment' } = {}) {
	const { vid_width, vid_height } = state.screen;
	const failures = [];
	for (const e of state.elements) {
		if (!e.rect) continue;
		if (e.rect.x < 0 || e.rect.y < 0 ||
			e.rect.x + e.rect.w > vid_width || e.rect.y + e.rect.h > vid_height) {
			failures.push({ element: e.name, rect: e.rect, screen: { vid_width, vid_height } });
		}
	}
	return { name, pass: failures.length === 0, failures };
}

// An element flush against an edge stays flush after resize: its relative
// offset from that edge scales with the ratio like everything else, so the
// check is that edge-alignment classification survives the resize.
export function alignment(before, after, { name = 'alignment', slack = 2 } = {}) {
	const failures = [];
	const byName = new Map(after.elements.map((e) => [e.name, e]));
	for (const b of before.elements) {
		const a = byName.get(b.name);
		if (!b.rect || !a?.rect) continue;
		const flushRight = Math.abs(b.rect.x + b.rect.w - before.screen.vid_width) <= slack;
		const flushBottom = Math.abs(b.rect.y + b.rect.h - before.screen.vid_height) <= slack;
		if (flushRight && Math.abs(a.rect.x + a.rect.w - after.screen.vid_width) > slack + 8) {
			failures.push({ element: b.name, edge: 'right', before: b.rect, after: a.rect });
		}
		if (flushBottom && Math.abs(a.rect.y + a.rect.h - after.screen.vid_height) > slack + 8) {
			failures.push({ element: b.name, edge: 'bottom', before: b.rect, after: a.rect });
		}
	}
	return { name, pass: failures.length === 0, failures };
}

// Byte-identical cvar strings between an exported config and the state a fresh
// session reaches after importing it (the existing pos_x string-round-trip rule,
// extended to every hud_* cvar).
export function roundTrip(exported, reimported, { name = 'round-trip' } = {}) {
	const failures = [];
	for (const [cvar, value] of Object.entries(exported)) {
		if (reimported[cvar] !== value) {
			failures.push({ cvar, exported: value, reimported: reimported[cvar] ?? null });
		}
	}
	return { name, pass: failures.length === 0, failures };
}

// Resize there and back must reproduce the original rects exactly: rounding
// drift accumulates silently and no golden file is needed to catch it.
export function metamorphic(original, returned, { name = 'metamorphic' } = {}) {
	const failures = [];
	const byName = new Map(returned.elements.map((e) => [e.name, e]));
	for (const o of original.elements) {
		const r = byName.get(o.name);
		if (!o.rect || !r?.rect) continue;
		if (['x', 'y', 'w', 'h'].some((k) => o.rect[k] !== r.rect[k])) {
			failures.push({ element: o.name, original: o.rect, returned: r.rect });
		}
	}
	return { name, pass: failures.length === 0, failures };
}

// The log-shape gate: a cell that passed geometry but logged something
// unexpected still needs eyes. `expected` counts by level.
export function logShape(entries, { errors = 0, maxWarns = 0, name = 'log-shape' } = {}) {
	const failures = [];
	const byLevel = { error: [], warn: [] };
	for (const e of entries) {
		if (byLevel[e.level]) byLevel[e.level].push(e);
	}
	if (byLevel.error.length !== errors) {
		failures.push({ level: 'error', expected: errors, actual: byLevel.error.length, entries: byLevel.error });
	}
	if (byLevel.warn.length > maxWarns) {
		failures.push({ level: 'warn', expected: `<=${maxWarns}`, actual: byLevel.warn.length, entries: byLevel.warn });
	}
	return { name, pass: failures.length === 0, failures };
}

// A cell where nothing is drawn proves nothing: every geometric invariant
// passes vacuously over an empty set. Refuse the vacuum explicitly.
export function nonVacuous(state, { min = 1, name = 'non-vacuous' } = {}) {
	const drawn = state.elements.filter((e) => e.rect).length;
	return {
		name,
		pass: drawn >= min,
		failures: drawn >= min ? [] : [{ drawn, min, note: 'no (or too few) elements drawn; geometric passes are meaningless' }],
	};
}

export function hudCvars(state) {
	const cvars = {};
	for (const e of state.elements) {
		for (const [cvar, value] of Object.entries(e.cvars ?? {})) {
			cvars[cvar] = value;
		}
		cvars[`hud_${e.name}_pos_x`] = String(e.pos_x);
		cvars[`hud_${e.name}_pos_y`] = String(e.pos_y);
		cvars[`hud_${e.name}_show`] = e.shown ? '1' : '0';
	}
	return cvars;
}
