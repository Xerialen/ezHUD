#!/usr/bin/env python3
"""Send a keypress to an X11 window via XTEST (ctypes, no python-xlib).

Usage: xkey.py <window-id-hex> <keysym-name> [delay-before]
Focuses the window, then fakes press+release of the key.
Keysym names supported here: F1..F12 (all this spike needs).
"""
import ctypes, sys, time

xlib = ctypes.CDLL("libX11.so.6")
xtst = ctypes.CDLL("libXtst.so.6")

xlib.XOpenDisplay.restype = ctypes.c_void_p
xlib.XOpenDisplay.argtypes = [ctypes.c_char_p]
xlib.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
xlib.XStringToKeysym.restype = ctypes.c_ulong
xlib.XStringToKeysym.argtypes = [ctypes.c_char_p]
xlib.XKeysymToKeycode.restype = ctypes.c_ubyte
xlib.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
xlib.XFlush.argtypes = [ctypes.c_void_p]
xlib.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

REVERT_TO_PARENT = 2
CURRENT_TIME = 0

def main():
    win = int(sys.argv[1], 16)
    key = sys.argv[2].encode()
    delay = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
    if delay:
        time.sleep(delay)
    dpy = xlib.XOpenDisplay(b":0.0")
    if not dpy:
        sys.exit("cannot open display")
    xlib.XSetInputFocus(dpy, win, REVERT_TO_PARENT, CURRENT_TIME)
    xlib.XSync(dpy, 0)
    time.sleep(0.15)
    keycode = xlib.XKeysymToKeycode(dpy, xlib.XStringToKeysym(key))
    if not keycode:
        sys.exit(f"no keycode for {key}")
    xtst.XTestFakeKeyEvent(dpy, keycode, 1, 0)
    xlib.XFlush(dpy)
    time.sleep(0.06)
    xtst.XTestFakeKeyEvent(dpy, keycode, 0, 0)
    xlib.XSync(dpy, 0)

if __name__ == "__main__":
    main()
