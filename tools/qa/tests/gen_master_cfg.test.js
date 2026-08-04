import assert from 'node:assert/strict';
import test from 'node:test';

import { generate } from '../gen_master_cfg.mjs';

function generatedElements(count = 9) {
	return {
		engine: 'fixture',
		elements: Array.from({ length: count }, (_, index) => ({
			name: `element${index}`,
			cvars: { [`hud_element${index}_scale`]: '2' },
		})),
	};
}

function value(cfg, name) {
	const match = new RegExp(`^${name} (.+)$`, 'm').exec(cfg);
	assert.ok(match, `missing ${name}`);
	return match[1];
}

test('master placements use the screen and point every edge offset inward', () => {
	const cfg = generate(generatedElements());
	for (let index = 0; index < 9; index++) {
		const name = `hud_element${index}`;
		const alignX = value(cfg, `${name}_align_x`);
		const alignY = value(cfg, `${name}_align_y`);
		const x = Number(value(cfg, `${name}_pos_x`));
		const y = Number(value(cfg, `${name}_pos_y`));

		assert.equal(value(cfg, `${name}_place`), 'screen');
		assert.equal(value(cfg, `${name}_scale`), '1');
		assert.ok(alignX === 'left' ? x > 0 : alignX === 'right' ? x < 0 : x === 0,
			`${name}: ${alignX} x offset ${x} points out of the frame`);
		assert.ok(alignY === 'top' ? y > 0 : alignY === 'bottom' ? y < 0 : y === 0,
			`${name}: ${alignY} y offset ${y} points out of the frame`);
	}
});

test('master keeps the realtime ping rect stable between resize checkpoints', () => {
	const cfg = generate({ engine: 'fixture', elements: [{ name: 'ping', cvars: {} }] });
	assert.equal(value(cfg, 'hud_ping_period'), '999999');
	assert.equal(value(cfg, 'hud_ping_show_pl'), '0');
	assert.equal(value(cfg, 'hud_ping_blink'), '0');
});
