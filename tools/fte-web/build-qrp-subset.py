#!/usr/bin/env python3
"""Build id1/qrp-dm3.pk3: QRP textures for exactly the maps the public site ships.

The GPL map remakes (gpl_maps.pk3) keep id's texture *names* but may not embed
id's art, so they render as near-bare walls. The Quake Retexturing Project's
packs are faithful, freely-redistributable recreations that engines apply by
name -- but the full set is ~390MB across four pk3s, which no web deploy
should carry for one map. This reads the texture name list straight out of the
shipped .bsp files and packs only those replacements (~32MB for dm3).

Reproducibility is the point of this script existing: the released pk3's hash
is pinned in game-data.sha256, and this is how those bytes were produced.

Usage:
  python3 tools/fte-web/build-qrp-subset.py \
      --gpl-maps /tmp/gpl_maps.pk3 --qrp-dir /tmp --out /tmp/qrp-dm3.pk3

--qrp-dir must hold qrp_1.pk3..qrp_4.pk3 (nQuake distfiles,
addon-textures/qw/qrp_maps_textures_N.pk3) and readme-textures.txt, which is
embedded as qrp-readme.txt because QRP's terms are redistribution with
attribution.
"""
import argparse
import re
import struct
import sys
import zipfile

MAPS = ['maps/dm3.bsp']  # both bundled demos play here


def bsp_texture_names(bsp):
    """The miptex names a v29 BSP references. Liquids keep their * prefix."""
    version, = struct.unpack('<i', bsp[:4])
    if version != 29:
        sys.exit(f'not a v29 quake bsp (version {version})')
    off, _length = struct.unpack('<ii', bsp[4 + 2 * 8:4 + 2 * 8 + 8])
    count, = struct.unpack('<i', bsp[off:off + 4])
    offsets = struct.unpack(f'<{count}i', bsp[off + 4:off + 4 + 4 * count])
    names = set()
    for o in offsets:
        if o < 0:  # a map can null out a slot
            continue
        names.add(bsp[off + o:off + o + 16].split(b'\0')[0].decode(errors='replace').lower())
    return names


def replacement_candidates(base):
    """Filenames engines try for a texture name. '*' is '#' on disk."""
    if base.startswith('*'):
        return [f'#{base[1:]}']
    return [base]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--gpl-maps', required=True)
    ap.add_argument('--qrp-dir', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    gpl = zipfile.ZipFile(args.gpl_maps)
    need = set()
    for m in MAPS:
        need |= bsp_texture_names(gpl.read(m))
    wanted = {}
    for base in need:
        for cand in replacement_candidates(base):
            wanted[cand] = base

    # Collect first, write sorted with a fixed timestamp: zipfile stamps
    # "now" on every entry by default, which made two runs over identical
    # inputs hash differently -- and the whole reason this pk3 has a build
    # script is that its release hash is pinned and must be re-derivable.
    entries = {}
    found = set()
    for i in (1, 2, 3, 4):
        src = zipfile.ZipFile(f'{args.qrp_dir}/qrp_{i}.pk3')
        for name in src.namelist():
            m = re.match(r'textures/([#a-z0-9_+\-]+)\.(png|tga|jpg)$', name.lower())
            if not m:
                continue
            base = m.group(1)
            if base in wanted and wanted[base] not in found:
                found.add(wanted[base])
                entries[name] = src.read(name)
    with open(f'{args.qrp_dir}/readme-textures.txt', 'rb') as f:
        entries['qrp-readme.txt'] = f.read()

    out = zipfile.ZipFile(args.out, 'w')
    for name in sorted(entries):
        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        out.writestr(info, entries[name])
    out.close()

    missing = sorted(need - found)
    print(f'needed {len(need)}, packed {len(found)}, missing: {missing or "none"}')
    if missing:
        sys.exit(1)


if __name__ == '__main__':
    main()
