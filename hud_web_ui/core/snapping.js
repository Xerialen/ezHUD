// core/snapping.js — editor-only drag assistance in console coordinates.
//
// The engine never knows about grids or magnets. These helpers turn a pointer
// proposal into final integer pos offsets; only those final values cross the
// bridge and therefore only those values can reach an exported config.

export function snapToGrid(value, step) {
	const spacing = Math.abs(Number(step));
	const input = Number(value);
	if (!Number.isFinite(input) || !Number.isFinite(spacing) || spacing <= 0) {
		return input;
	}
	return Math.sign(input) * Math.round(Math.abs(input) / spacing) * spacing;
}

// Which lines to draw for a grid of `step`, in console coordinates, over a
// console extent of `w` x `h`.
//
// One fixed lattice on the screen, at multiples of the step: a grid you can
// snap things INTO, where two elements dragged onto the same line are aligned
// with each other. That only holds because the drag snaps the element's
// POSITION onto this lattice and solves back for the offset (see beginDrag);
// snapping the offset instead would give every element its own lattice, shifted
// by wherever its anchor sits, and no two would ever agree.
//
// `minSpacing` is the closest the lines may be drawn on each axis, in console
// units. The caller converts its own legibility floor (CSS pixels) through the
// same transform the drag uses, because vid_conwidth and vid_conheight are
// independent: at 320x200 on a wide frame the horizontal lines can be twice as
// far apart as the vertical ones, and only one of the two may be too dense.
//
// Under the floor the cadence is COARSENED, never blanked: drawing every second
// or fourth line keeps every drawn line a real snap position while leaving the
// picture underneath readable. Blanking would answer a user who just ticked
// Grid with an empty stage, which is the defect this whole function exists to
// fix. Measured on a real frame (412x231 console, 830px stage): at 16 CSS px
// the grid reads as a grid, at 10 it is a veil and at 6 it dims the picture.
//
// Consequence, accepted deliberately: because the cadence must stay a WHOLE
// multiple of the step for the invariant above to hold, spacing is not
// monotonic in the step. A finer step can draw a coarser picture (5 draws wider
// than 8 when 8 already clears the floor), and two steps can draw the same
// grid. Smoothing that out would mean drawing lines a drag never lands on,
// which is the defect this replaced.
export function gridLines(step, extent, minSpacing = { x: 0, y: 0 }) {
	const spacing = Number(step);
	if (!Number.isFinite(spacing) || spacing <= 0) {
		return { x: [], y: [] };
	}
	const axis = (size, floor) => {
		const limit = Number(size);
		if (!Number.isFinite(limit) || limit <= 0) {
			return [];
		}
		// A whole multiple, so every line drawn is still somewhere a drag lands.
		const smallest = Math.max(0, Number(floor) || 0);
		const cadence = spacing * Math.max(1, Math.ceil(smallest / spacing));
		// Indexed rather than accumulated: += would drift on a fractional cadence
		// and quietly put lines where a drag does not land.
		const values = [];
		for (let i = 0; i * cadence < limit; i += 1) {
			values.push(i * cadence);
		}
		return values;
	};
	return {
		x: axis(extent?.w, minSpacing?.x),
		y: axis(extent?.h, minSpacing?.y),
	};
}

const axisPoints = (rect, axis) => {
	const start = axis === 'x' ? rect.x : rect.y;
	const size = axis === 'x' ? rect.w : rect.h;
	return [start, start + size / 2, start + size];
};

function nearestAxis(rect, targets, axis, threshold) {
	const limit = Math.max(0, Number(threshold) || 0);
	if (!limit) {
		return null;
	}
	const sourcePoints = axisPoints(rect, axis);
	let best = null;
	for (const target of targets) {
		if (!target?.rect) continue;
		for (const source of sourcePoints) {
			for (const destination of axisPoints(target.rect, axis)) {
				const delta = destination - source;
				const distance = Math.abs(delta);
				// The engine stores integer offsets. A half-pixel centre match would be
				// rounded away on write and leave a guide where no exact alignment exists.
				if (!Number.isInteger(delta)) continue;
				// Strictly nearer only: target/edge order is the deterministic tie-break.
				if (distance <= limit && (!best || distance < best.distance)) {
					best = { delta, distance, value: destination, target: target.name };
				}
			}
		}
	}
	return best;
}

export function magnetizeRect(rect, targets, threshold) {
	const source = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
	const x = nearestAxis(source, targets, 'x', threshold?.x);
	const y = nearestAxis(source, targets, 'y', threshold?.y);
	const delta = { x: x?.delta ?? 0, y: y?.delta ?? 0 };
	const guides = [];
	if (x) guides.push({ axis: 'x', value: x.value, target: x.target });
	if (y) guides.push({ axis: 'y', value: y.value, target: y.target });
	return {
		rect: { ...source, x: source.x + delta.x, y: source.y + delta.y },
		delta,
		guides,
	};
}
