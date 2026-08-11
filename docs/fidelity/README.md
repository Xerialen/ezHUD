# Fidelity reports — how the dated files here were produced

`tools/fidelity/run.sh` takes the measurement; the dated `*-fidelity.md` in this
directory are its output and `*-fidelity.json` is the machine-readable baseline
the next run diffs against (`FIDELITY_BASELINE=`, or `measure.mjs --check`).

This is an **owner-machine command, not CI** — see `docs/TESTING.md`, "The
fidelity gate". What follows is the recipe the 2026-08-07 report was produced
with, written down because the reference half cannot be started by a script
without guessing at a basedir and a demo position.

## Once, per machine

The reference half needs an ezQuake with the bridge in it. Stock nQuake will not
do: `hud_web` exists only in a build with `engine/engine-integration.diff`
applied. The runbook is `README.md`, "Building it into ezQuake". On pinnacle
this is `/home/xerial/dev/ezquake-hudweb`, built from upstream `a86996a3` — the
diff applies clean there. (`f35d7f8` is the commit the diff was cut against, if
a build against upstream master ever drifts.)

Game data comes from the owner's nQuake at `~/quake`: `id1/pak0.pak`,
`pak1.pak`, the gamedirs and the demos are registered content and are not in any
source repository.

**Do not point the engine at `~/quake` directly.** Use a throwaway basedir that
symlinks the data in, so a run cannot write into the real install:

```bash
BD=/home/xerial/dev/.fidelity-basedir
mkdir -p $BD/ezquake/configs
for d in id1 qw.xerial qw.ciscon stockgame; do ln -s ~/quake/$d $BD/$d; done
ln -s qw.xerial $BD/qw
for e in ~/quake/ezquake/*; do
  [ "$(basename "$e")" = configs ] || ln -s "$e" "$BD/ezquake/$(basename "$e")"
done
cp ~/quake/ezquake/configs/config.cfg $BD/ezquake/configs/
echo 'cl_onload console' >> $BD/ezquake/configs/config.cfg
```

`cl_onload console` is load-bearing: without it the main menu opens over the
demo and the engine never draws a HUD (`tools/tests/tier4.sh` explains why it
has to come from `config.cfg` rather than the command line).

## Per run

**1. The reference engine.** Console size is set here rather than over the
bridge, because a demo has to be loaded before anything else is worth sending:

```bash
cd $BD && xvfb-run -a -s "-screen 0 1280x720x24" \
  /home/xerial/dev/ezquake-hudweb/build/ezquake-linux-x86_64 \
  -basedir $BD -window -width 1280 -height 720 -condebug /tmp/ezq-ref.log \
  +cl_maxfps_menu 250 +vid_conwidth 640 +vid_conheight 480 \
  +hud_web_port 27811 +hud_web_frame_interval 0 \
  +scr_newhud 1 +playdemo demos/tb4gf_book_vs_s.mvd +hud_web 1 &
grep -a 'editor at' /tmp/ezq-ref.log      # origin and token
```

`cl_maxfps_menu 250` matters before the demo starts: it defaults to 0, and the
engine then divides by Xvfb's 0 Hz refresh and never completes a frame at the
menu.

**2. The preview engine** is started by `run.sh` itself through
`tools/qa/wasm_bridge.mjs`. Run it standalone only when driving `measure.mjs`
by hand.

**3. Put both on the same demo point** before measuring — `toggleconsole`,
`playdemo`, wait for the load, `demo_jump`, wait for the seek, then
`demo_setspeed`. `run.sh`'s `FIDELITY_FREEZE` sends its commands without waiting
between them, which is fine for a re-seek on engines that are already playing
and is not fine for a cold `playdemo`.

**4. Measure.**

```bash
REFERENCE_BRIDGE_URL=http://127.0.0.1:27811 REFERENCE_BRIDGE_TOKEN=<token> \
FIDELITY_CONFIG=~/quake/ezquake/configs/config.cfg \
EZHUD_FIDELITY_DEMO=$BD/qw/demos/tb4gf_book_vs_s.mvd \
FIDELITY_BASELINE=docs/fidelity/<previous>-fidelity.json \
  tools/fidelity/run.sh
```

## What the 2026-08-07 numbers are, and are not

Reproducible where it was checked: two consecutive reads agreed within the run,
and a full re-seek of both engines reproduced all 28 divergences with **zero**
drift against the previous baseline.

Not reproducible across an engine **restart**, and this is not a harness defect.
`demo_jump 9:00` lands on a keyframe and the two engines settle a second or two
apart, so elements whose width tracks their content move: across a restart,
`ownfrags` and `score_difference` changed verdict while every other row held —
a 16px score became 32px. Read a `size` divergence on a content-derived element
(`ownfrags`, `score_difference`, `fps`, `ping`, `itemsclock`) as a question, and
a `presence` or `position` divergence as a finding.

Same config as the 2026-08-01 spike (`config.cfg`, 1575 lines) and the same
demo, so the report is directly comparable to `spikes/fte-web/PARITY.md`.
