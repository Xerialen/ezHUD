// view/debug.js — the session log surfaced. F9 toggles it; off by default.
//
// The panel is built lazily on first open so users who never debug never pay
// for it. It shows the merged story: the UI ring live via a sink, the engine
// ring (GET /log) refetched on open and on Copy.

import * as syslog from '../core/log.js';

const LEVELS = ['error', 'warn', 'info', 'debug'];

export function initDebugPanel({ fetchEngineLog, meta }) {
	let panel = null;
	let list = null;
	let engineBox = null;
	let filter = { level: 'debug', area: '' };

	function row(entry) {
		const line = document.createElement('div');
		line.className = 'debuglog__row';
		line.dataset.level = entry.level;
		const data = 'data' in entry ? ` ${JSON.stringify(entry.data)}` : '';
		line.textContent = `${new Date(entry.t).toLocaleTimeString()} ${entry.level} [${entry.area}] ${entry.msg}${data}`;
		return line;
	}

	function repaint() {
		if (!panel || panel.hidden) { return; }
		const entries = syslog.snapshot({
			level: filter.level,
			area: filter.area || undefined,
		});
		list.replaceChildren(...entries.slice(-200).map(row));
		list.scrollTop = list.scrollHeight;
	}

	async function refreshEngine() {
		engineBox.textContent = (await fetchEngineLog()) || '(engine log unavailable)';
		engineBox.scrollTop = engineBox.scrollHeight;
	}

	function select(label, options, onchange) {
		const wrap = document.createElement('label');
		wrap.className = 'debuglog__filter';
		wrap.textContent = label;
		const control = document.createElement('select');
		for (const [value, text] of options) {
			const option = document.createElement('option');
			option.value = value;
			option.textContent = text;
			control.append(option);
		}
		control.addEventListener('change', () => onchange(control.value));
		wrap.append(control);
		return wrap;
	}

	function build() {
		panel = document.createElement('aside');
		panel.className = 'debuglog';
		panel.hidden = true;
		panel.setAttribute('aria-label', 'Session log');

		const head = document.createElement('div');
		head.className = 'debuglog__head';
		const title = document.createElement('strong');
		title.textContent = 'Session log';
		head.append(title);

		head.append(select('level', LEVELS.map((l) => [l, l]).reverse(), (v) => {
			filter.level = v; repaint();
		}));
		head.append(select('area', [['', 'all'], ...syslog.AREAS.map((a) => [a, a])], (v) => {
			filter.area = v; repaint();
		}));

		const copy = document.createElement('button');
		copy.type = 'button';
		copy.textContent = 'Copy log';
		copy.addEventListener('click', async () => {
			const blob = syslog.dump({ meta: meta(), engineLog: await fetchEngineLog() });
			try {
				await navigator.clipboard.writeText(blob);
				copy.textContent = 'Copied';
			} catch {
				// Clipboard needs a secure context; show the blob so it can still
				// be selected by hand rather than failing invisibly.
				engineBox.textContent = blob;
				copy.textContent = 'Select below';
			}
			setTimeout(() => { copy.textContent = 'Copy log'; }, 1500);
		});
		head.append(copy);

		const close = document.createElement('button');
		close.type = 'button';
		close.textContent = '×';
		close.setAttribute('aria-label', 'Close');
		close.addEventListener('click', toggle);
		head.append(close);

		list = document.createElement('div');
		list.className = 'debuglog__list';

		const engineTitle = document.createElement('div');
		engineTitle.className = 'debuglog__subtitle';
		engineTitle.textContent = 'engine (GET /log)';
		engineBox = document.createElement('pre');
		engineBox.className = 'debuglog__engine';

		panel.append(head, list, engineTitle, engineBox);
		document.body.append(panel);
		syslog.addSink(() => repaint());
	}

	function toggle() {
		if (!panel) { build(); }
		panel.hidden = !panel.hidden;
		if (!panel.hidden) {
			repaint();
			refreshEngine();
		}
	}

	window.addEventListener('keydown', (ev) => {
		if (ev.key === 'F9' && !ev.target.matches('input, select, textarea')) {
			ev.preventDefault();
			toggle();
		}
	});

	return { toggle };
}
