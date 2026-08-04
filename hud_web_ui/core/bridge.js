// core/bridge.js — the engine client.
//
// Everything this module knows about ezQuake goes through the loopback bridge
// documented in docs/hud-web/PROTOCOL.md. No DOM access: see PRODUCT.md ## Stack.

import * as syslog from './log.js';

const TOKEN_KEY = 't';

export class BridgeError extends Error {
	constructor(message, { status = 0 } = {}) {
		super(message);
		this.name = 'BridgeError';
		this.status = status;
	}

	// Anything thrown at a bridge call site, as a BridgeError. Only 403 is
	// unrecoverable, and `status` already carries that.
	static from(err) {
		return err instanceof BridgeError ? err : new BridgeError(String(err));
	}
}

export class Bridge {
	// `origin` lets a dev server talk to an engine on another port; the token is
	// the security boundary, not the origin.
	constructor({ token, origin = '' } = {}) {
		this.token = token ?? '';
		this.origin = origin.replace(/\/$/, '');
	}

	// The engine prints its URL with the token in the query string, so the token
	// arrives the same way when the user opens that URL.
	static fromLocation(search, origin = '') {
		const params = new URLSearchParams(search);
		return new Bridge({ token: params.get(TOKEN_KEY) ?? '', origin });
	}

	get configured() {
		return this.token.length > 0;
	}

	url(path, extra = {}) {
		const query = new URLSearchParams({ [TOKEN_KEY]: this.token, ...extra });
		return `${this.origin}${path}?${query}`;
	}

	// One log transition per outage, not one per failed poll: #alive flips on
	// the edges only.
	#alive = true;

	#reachable(reqId) {
		if (!this.#alive) {
			this.#alive = true;
			syslog.info('bridge', 'reconnected to engine', { reqId });
		}
	}

	async #json(path, init = {}) {
		const reqId = syslog.nextReqId();
		const started = performance.now();
		init.headers = { ...init.headers, 'X-HUD-Req': reqId };
		let response;
		try {
			response = await fetch(this.url(path), init);
		} catch (cause) {
			// fetch only rejects on transport failure, which here means the engine
			// went away rather than that the request was bad.
			if (this.#alive) {
				this.#alive = false;
				syslog.error('bridge', 'Lost contact with ezQuake', { reqId, path });
			}
			throw new BridgeError('Lost contact with ezQuake', { cause });
		}
		this.#reachable(reqId);
		syslog.debug('bridge', `${init.method ?? 'GET'} ${path}`, {
			reqId,
			status: response.status,
			ms: Math.round(performance.now() - started),
		});
		if (response.status === 403) {
			let refusal = null;
			try {
				refusal = await response.clone().json();
			} catch { /* a non-JSON 403 is still an authentication failure */ }
			if (path === '/cmd' && refusal?.error === 'command not permitted') {
				let command = '';
				try { command = JSON.parse(init.body ?? '{}').cmd ?? ''; } catch { /* diagnostic only */ }
				syslog.warn('bridge', '[hud_web] cmd rejected', { reqId, command });
				throw new BridgeError('Engine rejected command: command not permitted', { status: 403 });
			}
			syslog.error('bridge', 'token rejected (403)', { reqId, path });
			throw new BridgeError('This link is no longer valid', { status: 403 });
		}
		if (!response.ok) {
			syslog.error('bridge', `engine returned ${response.status}`, { reqId, path });
			throw new BridgeError(`Engine returned ${response.status}`, { status: response.status });
		}
		return response.json();
	}

	state() {
		return this.#json('/state', { cache: 'no-store' });
	}

	fonts() {
		return this.#json('/fonts', { cache: 'no-store' });
	}

	configs() {
		return this.#json('/configs', { cache: 'no-store' });
	}

	// A pak can replace the palette, so the 256 colours a bare number can mean are
	// the engine's to state, not ours to hardcode. Fetched once.
	palette() {
		return this.#json('/palette', { cache: 'no-store' });
	}

	// The engine's own log ring (GET /log), plain text. Best-effort: the debug
	// panel and the copy-log blob degrade to "(unavailable)" rather than fail.
	async logText() {
		try {
			const response = await fetch(this.url('/log'), { cache: 'no-store' });
			return response.ok ? await response.text() : '';
		} catch {
			return '';
		}
	}

	// Saving is two engine commands, not three: cfg_save writes a whole config,
	// hud_export writes only the hud_* cvars. "Overwrite" is not a third command —
	// it is what either one does when the name already exists, which is why the
	// caller has to decide about it rather than picking a mode.
	//
	// cfg_backup defaults to 0, meaning the old file is simply gone. Turn it on
	// before an overwrite -- but only for cfg_save, and put it back afterwards.
	//
	// hud_export does NOT honour it: DumpHUD does a bare fopen(outfile, "w")
	// (config_manager.c:882) and never reads cfg_backup, so a HUD-only overwrite
	// keeps no copy no matter what this is set to. The UI must not promise one.
	//
	// Restoring it matters more than it looks: leaving it on does not just change a
	// preference the user never touched, it gets written into the config they just
	// saved, so it follows them into every future session.
	async save({ name, hudOnly = false, keepBackup = false }) {
		const wantsBackup = keepBackup && !hudOnly;
		let restore = false;

		if (wantsBackup) {
			restore = (await this.backupEnabled()) === false;
			await this.setCvar('cfg_backup', 1);
		}
		try {
			await this.send(`${hudOnly ? 'hud_export' : 'cfg_save'} ${name}`);
		} finally {
			if (restore) {
				await this.setCvar('cfg_backup', 0);
			}
		}
	}

	// /configs already reports whether backups are on, which is the only cvar this
	// class needs to put back.
	async backupEnabled() {
		try {
			return (await this.configs())?.backup_enabled === true;
		} catch {
			return null;
		}
	}

	// Load a proportional face. Always via `fontload`, never `set font_facepath`:
	// OnChange_font_facepath reads Cmd_Argv(1) rather than the value it is given,
	// so the `set` form silently fails and leaves the old value in place.
	loadFace(name) {
		return this.send(`fontload ${name || 'none'}`);
	}

	// Cache-busted so the browser cannot hand back a stale render after an edit.
	frameUrl(nonce) {
		return this.url('/frame.png', { n: String(nonce) });
	}

	send(command) {
		return this.#json('/cmd', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ cmd: command }),
		});
	}

	setCvar(name, value) {
		return this.send(`${name} ${value}`);
	}
}
