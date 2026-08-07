// tools/fidelity/compare.mjs — the parity judgement, as pure functions.
//
// Both backends already speak one protocol: the bridge's /state, whose element
// rects are the engine's own resolved geometry rather than anything recomputed
// (engine/src/hud_web_state.c). So "does the preview look like the game" is, for
// everything a rect can express, a diff of two snapshots taken under the same
// config at the same console size. That part is measured here.
//
// What a rect cannot express — which texture drew, what colour it was tinted —
// is NOT measured here and is not guessed at. Those live as carried claims: a
// dated, sourced assertion that the run re-emits and marks stale when the
// element it describes stops being drawn. Inventing a pixel verdict across two
// different renderers would make the report longer and less true.

export const DIMENSIONS = ['presence', 'position', 'size'];
export const CARRIED_DIMENSIONS = ['texture', 'colour'];

const drawn = (element) => Boolean(element && element.rect);

function indexElements(state) {
	const byName = new Map();
	for (const element of state?.elements ?? []) {
		byName.set(element.name, element);
	}
	return byName;
}

function presenceRow(name, reference, preview) {
	if (reference && !preview) {
		return { verdict: 'diverges', code: 'not-registered-in-preview' };
	}
	if (!reference && preview) {
		return { verdict: 'diverges', code: 'not-registered-in-reference' };
	}
	if (drawn(reference) && drawn(preview)) {
		return { verdict: 'match', code: 'drawn-on-both-sides' };
	}
	if (drawn(reference) && !drawn(preview)) {
		return { verdict: 'diverges', code: 'preview-not-drawn' };
	}
	if (!drawn(reference) && drawn(preview)) {
		return { verdict: 'diverges', code: 'reference-not-drawn' };
	}
	return { verdict: 'absent-both', code: 'registered-but-drawn-by-neither' };
}

function geometryRow(dimension, reference, preview, tolerance) {
	if (!drawn(reference) || !drawn(preview)) {
		return { verdict: 'not-assessable', code: 'not-drawn-on-both-sides' };
	}
	const axes = dimension === 'position' ? ['x', 'y'] : ['w', 'h'];
	const delta = {};
	for (const axis of axes) {
		delta[axis] = preview.rect[axis] - reference.rect[axis];
	}
	const within = axes.every((axis) => Math.abs(delta[axis]) <= tolerance);
	return {
		verdict: within ? 'match' : 'diverges',
		code: within ? `${dimension}-within-tolerance` : `${dimension}-differs`,
		delta,
		reference: Object.fromEntries(axes.map((a) => [a, reference.rect[a]])),
		preview: Object.fromEntries(axes.map((a) => [a, preview.rect[a]])),
	};
}

/**
 * Compare one reference snapshot (real ezQuake) against one preview snapshot
 * (the FTE-web editor). Pure: same input, same output, no clock, no I/O.
 *
 * Returns a flat, sorted row list so two reports diff line by line instead of
 * being re-read by eye.
 */
export function compareStates({ reference, preview, tolerance = 0 } = {}) {
	const refScreen = reference?.screen ?? {};
	const prevScreen = preview?.screen ?? {};
	const base = {
		comparable: true,
		incomparable_reason: null,
		tolerance_px: tolerance,
		console: { width: refScreen.vid_width, height: refScreen.vid_height },
		engines: { reference: reference?.engine ?? null, preview: preview?.engine ?? null },
		counts: { elements: 0, matching: 0, diverging: 0, not_assessable: 0, absent_both: 0 },
		measured: [],
	};

	// Console pixels are the coordinate system every rect below is in. If the
	// two engines were not measured at the same one, the rects are in different
	// units and every verdict past this point would be fiction.
	if (refScreen.vid_width !== prevScreen.vid_width || refScreen.vid_height !== prevScreen.vid_height) {
		return {
			...base,
			comparable: false,
			incomparable_reason: `console size differs: reference ${refScreen.vid_width}x${refScreen.vid_height}, ` +
				`preview ${prevScreen.vid_width}x${prevScreen.vid_height}`,
		};
	}

	const referenceByName = indexElements(reference);
	const previewByName = indexElements(preview);
	const names = [...new Set([...referenceByName.keys(), ...previewByName.keys()])].sort();

	const measured = [];
	for (const name of names) {
		const ref = referenceByName.get(name) ?? null;
		const prev = previewByName.get(name) ?? null;
		for (const dimension of DIMENSIONS) {
			const judgement = dimension === 'presence'
				? presenceRow(name, ref, prev)
				: geometryRow(dimension, ref, prev, tolerance);
			measured.push({ element: name, dimension, ...judgement });
		}
	}

	const tally = (verdict) => measured.filter((row) => row.verdict === verdict).length;
	return {
		...base,
		counts: {
			elements: names.length,
			matching: tally('match'),
			diverging: tally('diverges'),
			not_assessable: tally('not-assessable'),
			absent_both: tally('absent-both'),
		},
		measured,
	};
}

/**
 * Re-emit the dimensions no rect can measure. A claim survives as `asserted`
 * only while the element it describes is still drawn by both engines; the
 * moment that stops being true the claim is `stale` and wants a human, because
 * nothing here can tell whether it was fixed or merely stopped rendering.
 */
export function carryClaims(result, claims = []) {
	const stillDrawn = new Set(
		result.measured
			.filter((row) => row.dimension === 'presence' && row.code === 'drawn-on-both-sides')
			.map((row) => row.element),
	);
	return [...claims]
		.sort((a, b) => a.element.localeCompare(b.element) || a.dimension.localeCompare(b.dimension))
		.map((claim) => stillDrawn.has(claim.element)
			? { ...claim, verdict: 'asserted' }
			: { ...claim, verdict: 'stale', note: 'the element is not drawn on both sides in this run, so the claim could not be carried forward' });
}
