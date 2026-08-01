import assert from 'node:assert/strict';
import test from 'node:test';

import { Bridge, BridgeError } from '../bridge.js';

test('Bridge.fromLocation reads only the token and normalizes the origin', () => {
	const bridge = Bridge.fromLocation('?other=1&t=abc%20123', 'http://127.0.0.1:27700/');
	assert.equal(bridge.token, 'abc 123');
	assert.equal(bridge.origin, 'http://127.0.0.1:27700');
	assert.equal(bridge.configured, true);
});

test('url puts the token on every route and preserves cache-busting extras', () => {
	const bridge = new Bridge({ token: 'secret', origin: 'http://localhost:99' });
	assert.equal(bridge.url('/state'), 'http://localhost:99/state?t=secret');
	assert.equal(bridge.frameUrl(42), 'http://localhost:99/frame.png?t=secret&n=42');
});

test('BridgeError.from preserves bridge errors and wraps foreign failures', () => {
	const denied = new BridgeError('denied', { status: 403 });
	assert.equal(BridgeError.from(denied), denied);
	const wrapped = BridgeError.from(new TypeError('offline'));
	assert.ok(wrapped instanceof BridgeError);
	assert.equal(wrapped.status, 0);
	assert.match(wrapped.message, /offline/);
});
