// fte/boot.js — brings the FTE wasm engine up underneath the editor.
//
// A classic script, not a module, and that is the whole reason it can do this
// job: engine/web/prejs.js reads Module the moment ftewebglcl.js is evaluated,
// so everything here has to be in place first, and a module would be deferred
// past it. It builds Module, shims #frame into something view/app.js can treat
// as an <img>, and injects the engine script itself.
//
// Nothing in this file knows about the editor's panels. The host chrome (demo
// picker, import drop zone, drift report) is fte/chrome.js, which is a module
// and runs after app.js.

(function () {
	'use strict';

	window.__ezhudEarlyLog = [];
	function engineSay(level, msg) {
		if (window.__ezhudLog) {
			window.__ezhudLog(level, 'fte', String(msg));
		} else {
			if (window.__ezhudEarlyLog.length < 200) {
				window.__ezhudEarlyLog.push([level, String(msg)]);
			}
			(level === 'warn' ? console.warn : console.log)(msg);
		}
	}

	// Shipped with the site by tools/fte-web/assemble.sh. `label` is what the
	// picker shows; `path` is the engine-side name, which is also the key the
	// file arrives under in Module.files.
	var BUNDLED_DEMOS = [
		{ label: 'hudtest (synthetic)', path: 'qw/demos/hudtest_src.mvd' },
		{ label: 'tb4gf: book vs s', path: 'qw/demos/tb4gf_book_vs_s.mvd' }
	];

	var DEMO_KEY = 'ezhud.fte.demo';        // last demo played, replayed on reload
	var VOLUME_KEY = 'ezhud.fte.volume';    // the fte-bar slider, written by chrome.js
	var MUTED_KEY = 'ezhud.fte.muted';      // '1' while the mute button is pressed
	var IMPORTED_DEMOS_KEY = 'ezhud.fte.demos'; // JSON array of imported .mvd paths

	function readJSON(key, fallback) {
		try {
			var raw = window.localStorage.getItem(key);
			return raw ? JSON.parse(raw) : fallback;
		} catch (e) {
			return fallback;
		}
	}

	function known() {
		var paths = BUNDLED_DEMOS.map(function (d) { return d.path; });
		var imported = readJSON(IMPORTED_DEMOS_KEY, []);
		return paths.concat(Array.isArray(imported) ? imported : []);
	}

	// An imported demo lives in the Cache API, and the engine loads that cache
	// itself at preRun (engine/web/prejs.js, Module['loadcachedfiles']), so the
	// name is enough -- boot does not have to fetch the bytes back.
	var initialDemo = (function () {
		var saved = null;
		try { saved = window.localStorage.getItem(DEMO_KEY); } catch (e) { /* private mode */ }
		return saved && known().indexOf(saved) >= 0 ? saved : BUNDLED_DEMOS[0].path;
	})();

	// A demo has two names. In Module.files and the Cache API it is an absolute
	// FS path ('qw/demos/foo.mvd' — that is where the bytes land); to `playdemo`
	// it is relative to the active gamedir, which the manifest's `basegame qw`
	// makes 'demos/foo.mvd'. Handing playdemo the FS path finds nothing.
	// (Verified live: 'playdemo qw/demos/x.mvd' fails, 'playdemo demos/x.mvd'
	// plays.)
	function demoCmdPath(path) {
		return String(path).replace(/^qw\//, '');
	}

	// What +volume gets: the fte-bar's stored state when there is any, else the
	// owner-decided quiet default (#10) — FTE's own default is `volume 0.7`,
	// which is far too loud under an editor. One constant, trivially adjustable.
	var initialVolume = (function () {
		var volume = null;
		var muted = null;
		try {
			volume = window.localStorage.getItem(VOLUME_KEY);
			muted = window.localStorage.getItem(MUTED_KEY);
		} catch (e) { /* private mode: the default it is */ }
		if (muted === '1') {
			return '0';
		}
		var n = parseFloat(volume);
		return n >= 0 && n <= 1 ? String(n) : '0.175';
	})();

	var canvas = document.getElementById('canvas');
	var statusEl = document.getElementById('fte-status');

	function say(text) {
		if (statusEl) {
			statusEl.textContent = text;
			statusEl.hidden = !text;
		}
	}

	// The wasm glue can replace either global while recovering from a restart.
	// Never let page-side code keep an instance handle past this call.
	function engine() {
		return {
			module: window.Module || null,
			ftec: window.FTEC || null
		};
	}

	// ---- the #frame shim ---------------------------------------------------
	// app.js believes #frame is the <img> holding the last captured frame: it
	// assigns .src, reads .naturalWidth/.naturalHeight for the render's true
	// size, and listens for 'load'. Here the render is the live canvas behind
	// it, so the natural size is the canvas backing store and there is nothing
	// to load. clientWidth and getBoundingClientRect() are left native and are
	// already correct, because the div is inset:0 over that same canvas.

	(function shimFrame() {
		var frame = document.getElementById('frame');
		if (!frame || !canvas) {
			return;
		}
		Object.defineProperty(frame, 'naturalWidth', { get: function () { return canvas.width; } });
		Object.defineProperty(frame, 'naturalHeight', { get: function () { return canvas.height; } });

		var src = '';
		Object.defineProperty(frame, 'src', {
			get: function () { return src; },
			set: function (value) {
				src = value;
				// Asynchronously: app.js assigns .src from inside its own
				// Image 'load' handler and only then sets frameReady, so a
				// synchronous dispatch would run renderOverlay against a state
				// that has not been updated yet.
				setTimeout(function () {
					frame.dispatchEvent(new Event('load'));
				}, 0);
			}
		});
	})();

	// ---- Module ------------------------------------------------------------

	var Module = {
		canvas: canvas,

		// String values are URLs the engine fetches before any C code runs
		// (prejs.js). Files the user imported are not listed here: they live in
		// the 'user' Cache under /_/<fs-path>, and prejs.js's loadcachedfiles()
		// reads that cache into the engine's own FS layer at preRun. Adding
		// them here as well would download the same bytes twice.
		// A listed file the server 404s is fine: prejs.js drops the run
		// dependency and moves on without registering it. That is what lets
		// this one list serve both sites -- the public dist ships
		// id1/nquake.pk3 (community art) but not pak1.pak (registered Quake,
		// not distributable), the dev site the other way around, and each
		// boots with what its server actually has.
		files: {
			'default.fmf': 'default.fmf',
			'id1/pak0.pak': 'id1/pak0.pak',
			'id1/pak1.pak': 'id1/pak1.pak',
			'id1/nquake.pk3': 'id1/nquake.pk3',
			// GPL remakes of the id maps (nQuake's gpl_maps.pk3). The public
			// dist has no pak1, so without this dm3 -- the map both bundled
			// demos play on -- exists nowhere and playdemo dies looking for
			// it; runtime download is no rescue (the community map repo hosts
			// no id maps and sends no CORS headers).
			'id1/gpl_maps.pk3': 'id1/gpl_maps.pk3',
			// QRP's faithful high-res remakes of exactly the textures dm3
			// references (32MB instead of the full 390MB QRP set). The GPL
			// remake bsp keeps id's texture *names* but must embed its own
			// minimal art; these replace by name, so the map reads as real
			// dm3 instead of untextured walls.
			'id1/qrp-dm3.pk3': 'id1/qrp-dm3.pk3',
			'qw/demos/hudtest_src.mvd': 'qw/demos/hudtest_src.mvd',
			'qw/demos/tb4gf_book_vs_s.mvd': 'qw/demos/tb4gf_book_vs_s.mvd',
			// Stats_NewMap auto-loads "fragfile" (engine/client/fragstats.c) with
			// no fallback; without it Stats_Evaluate never classifies an
			// obituary, so the killfeed tracker's FragEvent queue stays empty
			// forever even though the rect renders (#15). The public dist ships
			// it at qw/fragfile.dat; the dev server may not have staged a copy
			// yet, and a 404 here is tolerated the same as any other listed
			// file (prejs.js drops the run dependency and moves on).
			'qw/fragfile.dat': 'qw/fragfile.dat'
		},

		// Explicit, so prejs.js does not build a command line out of the query
		// string instead. plug_sbar 3 is "always let the hud plugin draw"
		// (engine/common/plugin.c:31); without it the plugin defers to the
		// engine's own sbar and the editor has nothing to place.
		arguments: [
			'-manifest', 'default.fmf',
			'+plug_sbar', '3',
			// `+set` rather than a bare `+scr_newhud 1`: the ezhud plugin
			// (LINK_EZHUD, statically linked) registers scr_newhud itself
			// (#15 P1), but plugin registration and the command line's
			// deferred "+" queue are two different subsystems, and this repo
			// carries no vendored fteqw source at the pinned SHA to prove
			// which one runs first. If argv runs before plugin init, a bare
			// +scr_newhud hits an unregistered cvar and logs "Unknown
			// command" at boot; if plugin init runs first, `+set` is a
			// harmless no-op-equivalent. Either way `+set` is the safe,
			// uniform choice (core/fte-adapter.js's wireLine()).
			'+set', 'scr_newhud', '1',
			// Owner decision (#10): demos default quiet — a quarter of FTE's
			// volume 0.7, not full blast under an editor. The value follows the
			// fte-bar's stored slider/mute state, so a reload never blasts a
			// volume the user already turned down.
			'+volume', initialVolume,
			'+playdemo', demoCmdPath(initialDemo)
		],

		// The stock shell's flag. Nothing in the engine reads it -- begin() is
		// the shell's job, so it is ours, and this is what ours honours.
		autostart: true,

		// Engine output goes to the session log (area "fte") so it is filterable
		// and lands in the copy-log blob. This file runs before the modules, so
		// lines queue in __ezhudEarlyLog until core/log.js is up and app.js
		// installs the live __ezhudLog hook and drains the queue.
		// stdout is debug-level: the engine is chatty enough to evict every
		// useful entry from the ring otherwise. stderr is always kept.
		print: function (msg) { engineSay('debug', msg); },
		printErr: function (msg) { engineSay('warn', msg); },

		setStatus: function (text) {
			// Emscripten spams this during startup, with a "(n/m)" progress
			// tail we have nowhere useful to put.
			say(String(text || '').replace(/\s*\(\d+(\.\d+)?\/\d+\)\s*$/, ''));
		},

		postRun: [function () {
			var module = engine().module;
			if (!module || module.sched === undefined) {
				say('FTE started but never set up its main loop. Reload, or try a 64-bit browser.');
			}
		}]
	};
	window.Module = Module;

	// ---- start -------------------------------------------------------------

	function begin() {
		var module = engine().module;
		if (!module || module.began) {
			return;
		}
		module.began = true;
		say('Loading engine…');
		var s = document.createElement('script');
		s.src = 'ftewebglcl.js';
		s.charset = 'utf-8';
		s.addEventListener('error', function () {
			say('Could not download ftewebglcl.js. Run tools/fte-web/assemble.sh and reload.');
		});
		document.head.appendChild(s);
	}

	// ---- readiness, keyboard, and the playdemo fallback --------------------

	function stateJSON() {
		var module = engine().module;
		if (!module || !module._EZHud_StateJSON || !module.UTF8ToString) {
			return null;
		}
		try {
			return JSON.parse(module.UTF8ToString(module._EZHud_StateJSON()));
		} catch (e) {
			return null;
		}
	}

	// No "already done" latch on purpose: FTEC.handleevent exists as soon as
	// ftejslib.js is evaluated, but the listeners are only registered when the
	// engine reaches emscriptenfte_setupcanvas — later, and not observably so.
	// A flag set on the first call can latch before the listeners exist and
	// leave them all in place (seen live: the beforeunload guard back from the
	// dead, blocking reloads). removeEventListener is idempotent, so watch()
	// just calls this every tick until the HUD draws, which is comfortably
	// after setupcanvas.
	function releaseKeyboard() {
		var ftec = engine().ftec;
		if (!ftec || !ftec.handleevent) {
			return;
		}
		// ftejslib.js:603-608 registers these on `document` in the capture
		// phase, so without this the engine sees every keystroke before the
		// editor does: Escape opens FTE's menu, ` its console, W walks the
		// camera. Remove exactly those listeners rather than swallowing the
		// events -- a capture-phase guard of our own would stop propagation
		// before app.js's arrow-key nudge, which listens on window and bubbles.
		//
		// Mouse and drop events need no such surgery: they are registered on
		// the canvas (ftejslib.js:600), which #frame covers with
		// pointer-events:none underneath it, so the canvas is never in the
		// event path at all.
		['keypress', 'keydown', 'keyup'].forEach(function (type) {
			document.removeEventListener(type, ftec.handleevent, true);
		});
		// Same surgery for beforeunload (registered on window, ftejslib.js:609):
		// FTE's "Leave site?" guard silently blocks location.reload(), and the
		// import pipeline's whole design is "write the cache, reload so preRun
		// picks it up" — with the guard in place a texture or demo import
		// stores the file and then hangs on a prompt nobody can see. The page
		// is an editor whose only unsaved state is a config export away; the
		// engine's own progress is not worth guarding here.
		window.removeEventListener('beforeunload', ftec.handleevent, true);
	}

	var started = Date.now();
	var demoRetried = false;
	var demoRetriedAt = 0;
	var lastFTEC = null;

	function watch() {
		var live = engine();
		var ftec = live.ftec;
		var replaced = false;
		if (ftec && lastFTEC && ftec !== lastFTEC) {
			replaced = true;
			window.dispatchEvent(new CustomEvent('ezhud:engine-replaced'));
			console.warn('FTE engine instance replaced; resolving fresh page-side handles.');
		}
		if (ftec) {
			lastFTEC = ftec;
		}

		releaseKeyboard();
		var state = stateJSON();
		var drawn = Boolean(state && (state.elements || []).some(function (e) { return e.rect; }));
		if (drawn) {
			say('');
			clearInterval(watch.timer);
			return;
		}
		if (replaced) {
			say('FTE restarted — waiting for the current engine to draw the HUD.');
		}

		// +playdemo on the command line runs before the manifest's gamedirs are
		// mounted in some orderings, and a demo that never started looks exactly
		// like a HUD with nothing to draw. Ask once more through the console,
		// which cannot race the filesystem because the filesystem is up by now.
		var now = Date.now();
		if (!demoRetried && state && now - started > 8000 && ftec) {
			demoRetried = true;
			demoRetriedAt = now;
			say('No HUD drawn yet — asking the engine to play ' + initialDemo + ' again.');
			ftec.cbufadd('playdemo ' + demoCmdPath(initialDemo) + '\n');
		} else if (demoRetried && now - demoRetriedAt > 10000) {
			say('No HUD was drawn after retrying the demo. Reload the page to try again.');
		}
	}

	watch.timer = setInterval(watch, 500);

	// ---- what the host chrome needs ---------------------------------------

	window.EZHUD_FTE = {
		engine: engine,
		bundledDemos: BUNDLED_DEMOS,
		initialDemo: initialDemo,
		demoKey: DEMO_KEY,
		importedDemosKey: IMPORTED_DEMOS_KEY,
		say: say,
		// Host-page chrome talks to the engine directly rather than through the
		// adapter: `playdemo` is deliberately absent from the editor's
		// allowlist (docs/PROTOCOL.md) and belongs to the page, not the editor.
		// `exec` stays forbidden everywhere -- an imported config is parsed by
		// fte/import.js and applied cvar by cvar, never handed to the console.
		play: function (path) {
			var ftec = engine().ftec;
			if (!ftec || /[;\r\n$"]/.test(path)) {
				return false;
			}
			try { window.localStorage.setItem(DEMO_KEY, path); } catch (e) { /* private mode */ }
			ftec.cbufadd('playdemo ' + demoCmdPath(path) + '\n');
			return true;
		}
	};

	if (engine().module.autostart) {
		begin();
	}
})();
