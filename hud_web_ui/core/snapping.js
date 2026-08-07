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
