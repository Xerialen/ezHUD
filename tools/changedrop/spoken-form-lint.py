#!/usr/bin/env python3
"""Flag narration text whose WRITTEN form differs from its SPOKEN form.

The defect this exists for: the release-2 NARRATION RECORD said "10:00". The engine spoke
"ten thousand". Every gate we had compared film to script, or script to script.
None of them listened, so a number that reads correctly and speaks wrongly passed
ten checks and reached the owner.

This does not listen either. It removes the class of input that makes listening
necessary, before anything is recorded.

Run it against narration.json -- the text handed to the voice engine. The
changedrop script does NOT contain the spoken words; pointed there this lint
returns a tidy PASS and can never go red (measured 2026-08-10).

Exit: 0 clean, 1 findings, 2 usage, 3 error.
"""
import json, re, sys

# HARD: forms where the spoken rendering is genuinely ambiguous or known-wrong.
HARD = [
    (re.compile(r'\b\d{1,2}:\d{2}\b'),      'clock/colon form', 'write it as spoken: "10 minutes", "ten past four"'),
    (re.compile(r'\b\d+\.\d+\b'),           'decimal',          'write it as spoken: "one point five seconds"'),
    (re.compile(r'\b\d{4,}\b'),             '4+ digit number',  'write it as spoken, or split it'),
    (re.compile(r'\b\d+\s*[-–]\s*\d+\b'),   'numeric range',    'write "three to five", not "3-5"'),
    (re.compile(r'[%&/#=+]'),               'symbol',           'write the word: per cent, and, or, number, equals, plus'),
    (re.compile(r'\b(?:e\.g\.|i\.e\.|etc\.|vs\.)'), 'abbreviation', 'write it out'),
]
# SOFT: small integers. Usually spoken correctly, but they are the same family,
# so they are reported and NOT failed. Reported so the count is visible, not
# hidden -- a lint that fails on "release 2" gets switched off, and a lint that
# is switched off is not an instrument.
SOFT = re.compile(r'\b\d{1,3}\b')

FIELDS = ('text', 'before', 'after', 'value', 'instruction')

def walk(node, path=''):
    if isinstance(node, dict):
        for k, v in node.items():
            yield from walk(v, f'{path}.{k}' if path else k)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk(v, f'{path}[{i}]')
    elif isinstance(node, str) and path.split('.')[-1].split('[')[0] in FIELDS:
        yield path, node

def main(argv):
    if len(argv) != 2:
        print('usage: spoken-form-lint.py <narration.json>   (NOT the changedrop script)', file=sys.stderr)
        return 2
    try:
        with open(argv[1]) as fh:
            doc = json.load(fh)
    except Exception as exc:                      # noqa: BLE001
        print(f'ERROR: cannot read {argv[1]}: {exc}', file=sys.stderr)
        return 3

    hard, soft = [], []
    for path, text in walk(doc):
        for rx, kind, fix in HARD:
            for m in rx.finditer(text):
                hard.append((path, m.group(0), kind, fix))
        for m in SOFT.finditer(text):
            soft.append((path, m.group(0)))

    for path, tok, kind, fix in hard:
        print(f'FAIL  {path}\n      {tok!r} -- {kind}\n      {fix}')
    if soft:
        print(f'\nnote: {len(soft)} small integers present (spoken form usually safe, not failed):')
        print('      ' + ', '.join(sorted({t for _, t in soft})))
    if not hard:
        print('PASS  no written/spoken mismatches of the hard class')
    return 1 if hard else 0

if __name__ == '__main__':
    sys.exit(main(sys.argv))
