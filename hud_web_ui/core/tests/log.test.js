import assert from 'node:assert/strict';
import test from 'node:test';

import * as syslog from '../log.js';

test.beforeEach(() => syslog._reset());

test('entries land in the ring and snapshot filters by level and area', () => {
	syslog.error('bridge', 'boom');
	syslog.info('model', 'set hud_health_scale');
	syslog.warn('geometry', 'rect null');

	assert.equal(syslog.snapshot().length, 3);
	assert.equal(syslog.snapshot({ level: 'error' }).length, 1);
	assert.equal(syslog.snapshot({ level: 'warn' }).length, 2);
	assert.equal(syslog.snapshot({ area: 'model' })[0].msg, 'set hud_health_scale');
});

test('debug entries are dropped unless debug is enabled', () => {
	syslog.debug('bridge', 'GET /state');
	assert.equal(syslog.snapshot().length, 0);

	syslog.setDebug(true);
	syslog.debug('bridge', 'GET /state');
	assert.equal(syslog.snapshot().length, 1);
	assert.equal(syslog.debugOn(), true);
});

test('ring caps at 500 and the dump reports the overflow', () => {
	for (let i = 0; i < 510; i++) syslog.info('view', `line ${i}`);
	const all = syslog.snapshot();
	assert.equal(all.length, 500);
	assert.equal(all[0].msg, 'line 10');
	assert.match(syslog.dump(), /ring overflow: 10 oldest/);
});

test('sinks see entries and a throwing sink is removed, not fatal', () => {
	const seen = [];
	syslog.addSink((e) => seen.push(e.msg));
	syslog.addSink(() => { throw new Error('bad sink'); });

	syslog.info('view', 'one');
	syslog.info('view', 'two');
	assert.deepEqual(seen, ['one', 'two']);
	assert.equal(syslog.snapshot().length, 2);
});

test('addSink returns an unsubscribe', () => {
	const seen = [];
	const off = syslog.addSink((e) => seen.push(e.msg));
	syslog.info('view', 'kept');
	off();
	syslog.info('view', 'dropped');
	assert.deepEqual(seen, ['kept']);
});

test('dump contains meta, both sections, and entry data', () => {
	syslog.error('bridge', 'Lost contact with ezQuake', { reqId: 'ab-1' });
	const blob = syslog.dump({
		meta: { engine: 'fte test', protocol: 1 },
		engineLog: '[hud_web] GET /state 200',
	});
	assert.match(blob, /engine: fte test/);
	assert.match(blob, /--- ui ---/);
	assert.match(blob, /Lost contact with ezQuake \{"reqId":"ab-1"\}/);
	assert.match(blob, /--- engine ---\n\[hud_web\] GET \/state 200/);
});

test('dump marks a missing engine log as unavailable', () => {
	assert.match(syslog.dump(), /--- engine ---\n\(unavailable\)/);
});

test('request ids are unique and monotonic within a page', () => {
	const a = syslog.nextReqId();
	const b = syslog.nextReqId();
	assert.notEqual(a, b);
	assert.equal(a.split('-')[0], b.split('-')[0]);
	assert.equal(Number(b.split('-')[1]), Number(a.split('-')[1]) + 1);
});
