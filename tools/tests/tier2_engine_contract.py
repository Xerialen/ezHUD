#!/usr/bin/env python3
"""Black-box security contract for a running ezQuake HUD web bridge."""

import argparse
import glob
import http.client
import json
import os
import pathlib
import re
import struct
import sys
import time
import urllib.parse


TOKEN_RE = re.compile(r"HUD bridge: editor at http://127\.0\.0\.1:(\d+)/\?t=([0-9a-f]{32})")


class Failure(RuntimeError):
    pass


def wait_for(predicate, message, timeout=15.0):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except (OSError, ValueError) as error:
            last_error = error
        time.sleep(0.05)
    suffix = f" ({last_error})" if last_error else ""
    raise Failure(f"timed out waiting for {message}{suffix}")


def log_text(path):
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return ""


def tokens(path, port):
    return [token for found_port, token in TOKEN_RE.findall(log_text(path))
            if int(found_port) == port]


def request(port, method, path, token=None, body=None, headers=None):
    query = urllib.parse.urlencode({"t": token}) if token is not None else ""
    target = path + (("&" if "?" in path else "?") + query if query else "")
    encoded = None
    headers = dict(headers or {})
    if body is not None:
        encoded = json.dumps({"cmd": body}).encode("utf-8")
        headers["content-type"] = "application/json"
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        connection.request(method, target, body=encoded, headers=headers)
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


def expect_status(port, token, command, expected=403):
    status, _, body = request(port, "POST", "/cmd", token, command)
    if status != expected:
        raise Failure(f"{command!r}: expected HTTP {expected}, got {status}: {body!r}")


def fifo_path():
    candidates = [pathlib.Path(path) for path in glob.glob("/tmp/ezquake_fifo_*")]
    candidates = [path for path in candidates if path.exists()]
    if not candidates:
        return None
    return max(candidates, key=lambda path: path.stat().st_mtime_ns)


def send_ipc(command):
    path = wait_for(fifo_path, "ezQuake IPC FIFO")

    def write():
        descriptor = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
        try:
            os.write(descriptor, (command + "\n\0").encode("utf-8"))
        finally:
            os.close(descriptor)
        return True

    wait_for(write, f"IPC reader for {command!r}")


def assert_loopback_listener(port):
    wanted_port = f"{port:04X}"
    listeners = []
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = pathlib.Path(table).read_text().splitlines()[1:]
        except FileNotFoundError:
            continue
        for line in lines:
            fields = line.split()
            address, found_port = fields[1].split(":")
            if found_port == wanted_port and fields[3] == "0A":
                listeners.append((table, address))
    if not listeners:
        raise Failure(f"port {port} is not listed as a listening socket")
    if any(address in {"00000000", "00000000000000000000000000000000"}
           for _, address in listeners):
        raise Failure(f"port {port} is bound to a wildcard address: {listeners}")
    if not any(table.endswith("tcp") and address == "0100007F" for table, address in listeners):
        raise Failure(f"port {port} is not explicitly bound to 127.0.0.1: {listeners}")


def png_dimensions(data):
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise Failure("/frame.png did not return a PNG with an IHDR")
    return struct.unpack(">II", data[16:24])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", required=True, type=pathlib.Path)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--engine-pid", required=True, type=int)
    args = parser.parse_args()

    def engine_alive():
        try:
            os.kill(args.engine_pid, 0)
            return True
        except OSError:
            raise Failure(f"ezQuake exited before opening the bridge; see {args.log}")

    wait_for(engine_alive, "ezQuake process")
    token = wait_for(lambda: (tokens(args.log, args.port) or [None])[-1], "bridge token")
    wait_for(lambda: request(args.port, "GET", "/state", token)[0] == 200, "authorised /state")
    assert_loopback_listener(args.port)

    status, _, _ = request(args.port, "GET", "/state")
    if status != 403:
        raise Failure(f"request without token was not refused: HTTP {status}")

    status, _, state_body = request(args.port, "GET", "/state", token)
    state = json.loads(state_body)
    if status != 200:
        raise Failure(f"authorised /state failed: HTTP {status}")

    # Unknown parameters, including the removed scale knob, must be ignored. A
    # successful response at any other dimensions would revive the old lie that
    # scale was honored by capture.
    status, _, frame_body = request(args.port, "GET", "/frame.png?scale=0.5", token)
    if status != 200:
        raise Failure(f"/frame.png?scale=0.5 should be a native PNG, got HTTP {status}")
    if png_dimensions(frame_body) != tuple(state["physical"]):
        raise Failure("scale=0.5 changed frame dimensions instead of being ignored")
    limited_status, limited_headers, _ = request(args.port, "GET", "/frame.png?n=limited", token)
    if limited_status != 503 or "retry-after" not in {
            name.lower(): value for name, value in limited_headers.items()}:
        raise Failure("frame rate limiting did not return 503 with Retry-After")
    send_ipc("hud_web_frame_interval 0")

    expect_status(args.port, token, "hud_tracking_format $rcon_password")
    for command in ("hud_web 0", "hud_web_port 29999", "hud_web_frame_interval 0"):
        expect_status(args.port, token, command)
    for command in ("hud_face_pos_x 1;quit", "hud_face_pos_x 1\rquit", "hud_face_pos_x 1\nquit"):
        expect_status(args.port, token, command)
    for command in ("exec autoexec.cfg", "quit", "rcon status", "togglehud rcon_password"):
        expect_status(args.port, token, command)
    expect_status(args.port, token, "hud_face_pos_x")  # cvar reads are not assignments
    expect_status(args.port, token, "hud_missing_contract_cvar 1")
    expect_status(args.port, token, "hud_\x7fcontract 1")
    expect_status(args.port, token, "hud_face_pos_x " + "1" * 1024)

    # Prove this name really is a user alias before testing the Cvar_Find guard.
    before = log_text(args.log).count("HUD_CONTRACT_ALIAS_RAN")
    send_ipc("hud_contract_alias 1")
    wait_for(lambda: log_text(args.log).count("HUD_CONTRACT_ALIAS_RAN") > before,
             "the user alias control invocation")
    count = log_text(args.log).count("HUD_CONTRACT_ALIAS_RAN")
    expect_status(args.port, token, "hud_contract_alias 1")
    time.sleep(0.15)
    if log_text(args.log).count("HUD_CONTRACT_ALIAS_RAN") != count:
        raise Failure("an allowlisted-prefix name that exists only as an alias executed")

    # Killfeed controls: the r_tracker prefix and the two exact names are
    # allowlisted, and what is set must come back in the state's killfeed block
    # (values are the engine's own cvar strings).
    for command in ("r_tracker 0", "con_fragmessages 0", "cl_useimagesinfraglog 1"):
        expect_status(args.port, token, command, expected=200)

    def killfeed_state():
        _, _, body = request(args.port, "GET", "/state", token)
        return json.loads(body).get("killfeed") or {}

    wait_for(lambda: killfeed_state().get("r_tracker") == "0"
             and killfeed_state().get("con_fragmessages") == "0"
             and killfeed_state().get("cl_useimagesinfraglog") == "1",
             "killfeed cvars reflected in /state")
    expect_status(args.port, token, "r_tracker 1", expected=200)
    wait_for(lambda: killfeed_state().get("r_tracker") == "1",
             "r_tracker 1 reflected in /state")
    # The prefix conjures no cvars: a made-up r_tracker-prefixed name fails the
    # Cvar_Find guard, and names off the allowlist stay refused.
    expect_status(args.port, token, "r_trackerfoo 1")
    expect_status(args.port, token, "r_speeds 1")

    status, _, configs_body = request(args.port, "GET", "/configs", token)
    if status != 200:
        raise Failure(f"/configs failed: HTTP {status}")
    export_dir = pathlib.Path(json.loads(configs_body)["export_dir"]).resolve()
    unique = f"hud_web_traversal_{os.getpid()}"
    inside = export_dir / f"{unique}.cfg"
    escaped = (export_dir / ".." / ".." / f"{unique}.cfg").resolve()
    try:
        expect_status(args.port, token, f"hud_export ../../{unique}", expected=200)
        wait_for(inside.exists, f"safe hud_export destination {inside}")
        if escaped != inside and escaped.exists():
            raise Failure(f"hud_export traversal escaped configs: {escaped}")
    finally:
        if inside.exists():
            inside.unlink()

    # The request log: token-gated like every stateful route, and the token must
    # never appear in its own audit trail (targets are logged path-only).
    status, _, _ = request(args.port, "GET", "/log")
    if status != 403:
        raise Failure(f"/log without token was not refused: HTTP {status}")
    status, log_headers, log_body = request(args.port, "GET", "/log", token)
    if status != 200:
        raise Failure(f"authorised /log failed: HTTP {status}")
    log_content_type = {name.lower(): value for name, value in log_headers.items()}.get("content-type", "")
    if "text/plain" not in log_content_type:
        raise Failure(f"/log content-type is {log_content_type!r}, not text/plain")
    log_output = log_body.decode("utf-8", "replace")
    if token in log_output:
        raise Failure("/log leaks the bridge token into its own output")
    if "GET /state" not in log_output:
        raise Failure("/log ring is missing the request lines this test already caused")
    # The correlation id round-trip: a request tagged X-HUD-Req comes back in the ring.
    request(args.port, "GET", "/state", token, headers={"X-HUD-Req": "contract-42"})
    _, _, log_body = request(args.port, "GET", "/log", token)
    if "req=contract-42" not in log_body.decode("utf-8", "replace"):
        raise Failure("X-HUD-Req was not echoed into the request log")

    # hud_web 0 closes the socket and clears its token. Re-enable over the engine's
    # local IPC channel, then prove that the old URL cannot authorize the new listener.
    send_ipc("hud_web 0")

    def bridge_closed():
        try:
            request(args.port, "GET", "/state", token)
            return False
        except OSError:
            return True

    wait_for(bridge_closed, "bridge socket to close")
    send_ipc("hud_web 1")
    new_token = wait_for(
        lambda: next((value for value in reversed(tokens(args.log, args.port)) if value != token), None),
        "rotated bridge token")
    wait_for(lambda: request(args.port, "GET", "/state", new_token)[0] == 200,
             "re-enabled bridge")
    status, _, _ = request(args.port, "GET", "/state", token)
    if status != 403:
        raise Failure(f"stale token after hud_web 0 was not refused: HTTP {status}")

    print("Tier 2 engine: all bridge security and HTTP contract checks passed")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Failure as error:
        print(f"TIER 2 ENGINE FAILURE: {error}", file=sys.stderr)
        sys.exit(1)
