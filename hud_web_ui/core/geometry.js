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

// Kept for callers that genuinely want one number (the readout, and the transfer
// ratio for a uniform scale cvar). Anything positional must use scaleFactors.
export function scaleFactor(screen, physical) {
	return scaleFactors(screen, physical).kx;
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
