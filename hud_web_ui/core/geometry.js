// core/geometry.js — the one place that knows about ezQuake's two coordinate spaces.
//
// The engine reports rects in CONSOLE pixels (e.g. 320x200) while the frame it
// renders is PHYSICAL (e.g. 1280x720). Getting this transform wrong puts every
// handle in the wrong place, so it lives here alone and is unit-testable.
//
// No DOM access: see PRODUCT.md ## Stack.

// ezQuake lets vid_conwidth and vid_conheight be set independently of each other
// and of the framebuffer (vid_sdl2.c:1928), so the vertical ratio is not always
// the horizontal one. Using the horizontal for both put every handle in the wrong
// place vertically the moment someone picked a console size of a different shape
// than their screen -- and a QA run at 512x288 on 2560x1440 could never catch it,
// because there both ratios are 5.
export function scaleFactors(screen, physical) {
	const kx = screen?.vid_width && physical?.[0] ? physical[0] / screen.vid_width : 1;
	const ky = screen?.vid_height && physical?.[1] ? physical[1] / screen.vid_height : kx;
	return { kx, ky };
}

// Console rect -> a rect in the frame image's own pixel space.
export function consoleToFrame(rect, screen, physical) {
	const { kx, ky } = scaleFactors(screen, physical);
	return { x: rect.x * kx, y: rect.y * ky, w: rect.w * kx, h: rect.h * ky };
}

// A drag happens in displayed CSS pixels; the engine only accepts console
// pixels. `displayWidth` is how wide the frame is actually drawn on screen.
export function displayDeltaToConsole(dx, dy, screen, physical, displayWidth) {
	if (!displayWidth || !physical?.[0]) {
		return { dx: 0, dy: 0 };
	}
	// The image is drawn to one width and keeps its aspect, so one display->frame
	// ratio covers both axes; the console ratios are what differ.
	const displayToFrame = physical[0] / displayWidth;
	const { kx, ky } = scaleFactors(screen, physical);
	return { dx: (dx * displayToFrame) / (kx || 1), dy: (dy * displayToFrame) / (ky || 1) };
}

// ezQuake stores pos_x/pos_y into ints, so a fractional offset is silently
// truncated toward zero by the engine. Round here so what the user sees while
// dragging is what the engine will actually store, rather than letting the
// display and the engine disagree by up to a pixel per axis.
export function quantize(value) {
	return Math.trunc(value);
}

// Where the engine's alignment puts an element before its offset is added, in
// whole console pixels.
//
// pos_x/pos_y are float cvars and reach us fractional (hud_web_state.c:183
// emits the cvar value), while rect is emitted as %d (hud_web_state.c:218)
// because libhud_place.c:149 does `int x; x += props->pos_x` and the sum is
// truncated. `rect - pos` is therefore NOT the alignment: it is the alignment
// plus the fraction the engine discarded. Anything drawn on that basis sits up
// to a pixel off a position no element can ever occupy, because a drag writes a
// whole offset and the reachable positions are `base + whole offset`.
export function alignmentBase(rectValue, pos) {
	const offset = Number(pos) || 0;
	if (!Number.isFinite(rectValue)) {
		return 0;
	}
	// Truncation is toward zero, so it is a floor while `align + pos` is positive
	// and a ceil while it is negative. We only have the truncated rect, which is
	// why this is an inverse of a lossy map rather than a computation, and it has
	// two known limits, both bounded at one console pixel:
	//
	//   * trunc collapses (-1, 1) onto 0, so at rect 0 a base of 0 and a base of
	//     -1 are indistinguishable and this picks 0.
	//   * libhud_place.c:166 reports `x + frame_left`, and frame_left (2, 4, or
	//     8 + (w%16)/2 for a text box) is not in the state JSON -- hud_web_state.c
	//     emits no `al`. The base this returns is therefore `align + frame_left`,
	//     which is still whole and still the right lattice for the rect, but it
	//     widens the band where the sign test above picks the wrong branch.
	//
	// Both only bite while pos is fractional, which is the state of an element
	// nobody has dragged yet: the first grid drag writes a whole pos and every
	// one after it is exact.
	return rectValue - (rectValue >= 0 ? Math.floor(offset) : Math.ceil(offset));
}

// Single source for element-name → data-changedrop normalisation.
// Imported by view/app.js (editor) and tools/tests/selector_hooks.test.mjs
// (test-time enforcement). Callers decide error handling — the normaliser
// only reports validity; the editor warns, the test throws.

const CHANGEDROP_VALUE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Normalise an element name to a kebab-case fragment.
 *
 * Collapses runs of non-alphanumeric characters to a single hyphen and trims
 * leading/trailing hyphens. Returns the fragment and whether it is still valid
 * (only possible when every character is non-alphanumeric, e.g. "___" → "").
 *
 * @param {string} name  Engine element name (e.g. "score__bar", "bar_", "_bar").
 * @returns {{ fragment: string, valid: boolean }}
 */
export function normaliseElementName(name) {
	const fragment = name.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return { fragment, valid: CHANGEDROP_VALUE.test(fragment) };
}

// Hit test in console space, topmost (highest draw order) first.
export function elementAt(elements, cx, cy) {
	const hits = elements.filter(
		(e) => e.rect &&
			cx >= e.rect.x && cx < e.rect.x + e.rect.w &&
			cy >= e.rect.y && cy < e.rect.y + e.rect.h,
	);
	if (!hits.length) {
		return null;
	}
	// Later draw order sits on top, matching what the player sees.
	return hits.reduce((top, e) => (e.order >= top.order ? e : top));
}
