# Spec — #43: demo playback pause wired end-to-end

Status: approved for implementation (Sol). Reviewer: Claude.
Parent: #39. Absorbs the pause half of #23; preset moments stay in #23.

## Engine facts (verified in fork source, cl_main.c)

`demo_setspeed` takes a **percent**: `atof(arg)/100 → cl_demospeed`
(default 1 = 100%). So pause = `demo_setspeed 0`, resume =
`demo_setspeed 100`. The issue text's "demo_setspeed 1" would be 1% —
do not copy it. Engine state readback: `cl_demospeed` ("0" paused,
"1" normal). Note: freezing stops demo packets, not `cl.time` — the
gameclock keeps ticking (tier4_fte case 36 documents this).

## Requirement

A pause/resume toggle in the editor's demo controls (fte-bar, next to the
volume control — #10/#14 pattern):

- FTE backend: send `demo_setspeed 0` / `demo_setspeed 100` over the
  existing command channel; the button reflects `cl_demospeed` read back
  from the engine (state poll), not click state.
- ezQuake backend: use its demo-speed equivalent through the bridge command
  allowlist, extending the allowlist explicitly in `HUD_Web_CommandAllowed`
  with tier-2 negative tests per TESTING.md (a rejected command must surface
  in the session log, not silently no-op).
- Backend without the capability: control renders disabled with a reason and
  one `warn`-level session-log entry (log-shape assertion).

## Cases → tests (issue #43 Cases 1–5)

1. Toggle pause → gameclock element rect/text stops changing across two
   1s-apart reads; resume → changes again. NOTE the engine fact above:
   if the FTE gameclock tracks cl.time rather than demo time, prove case 1
   against a demo-time-driven observable (e.g. a frag row appearing, or
   itemsclock) and document which observable was chosen and why. Tier-3F
   fake-clock unit + tier-4F real case.
2. Console `demo_setspeed 0` → toggle shows paused on next poll (tier-4F).
3. Disabled-backend path: reason shown + one warn log entry (tier-3F with
   fake engine refusing the command).
4. QA matrix unchanged: cells still freeze via the same command path — no
   second mechanism (review check on the diff).
5. Rejected-command path (ezQuake, allowlist not extended in a stale build):
   UI surfaces the `[hud_web] cmd rejected` diagnostic (tier-2 JS test at
   the bridge layer).

New GUI control ⇒ ships WITH its tier-4F controlCases row (#18 convention);
case 35 coverage audit must keep passing.
