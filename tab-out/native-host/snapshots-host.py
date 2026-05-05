#!/usr/bin/env python3
"""Tab Out cross-profile snapshot host.

Chrome native messaging host. One process per request — Chrome spawns it,
sends one message, reads one response, kills it. Stateless.

Snapshots are JSON files at ~/.tab-out/snapshots/<profileId>.json so each
profile owns exactly one file. read merges all files; write replaces one.

Protocol: 4-byte little-endian length prefix + UTF-8 JSON message, both ways.

Commands:
  { "cmd": "write", "snapshot": { profileId, profileLabel, updatedAt, tabs } }
    -> { "ok": true }
  { "cmd": "read", "excludeProfileId": "..." }
    -> { "ok": true, "snapshots": [ ... ] }
"""

import json
import os
import struct
import sys
import time
from pathlib import Path

SNAPSHOT_DIR = Path.home() / ".tab-out" / "snapshots"
MAX_MESSAGE_BYTES = 4 * 1024 * 1024  # 4 MiB cap per message


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    length = struct.unpack("<I", raw_length)[0]
    if length == 0 or length > MAX_MESSAGE_BYTES:
        return None
    raw = sys.stdin.buffer.read(length)
    if len(raw) < length:
        return None
    return json.loads(raw.decode("utf-8"))


def send_message(msg):
    encoded = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def safe_id(value):
    """Strip everything but [A-Za-z0-9_-]; cap length. Stops path traversal."""
    return "".join(c for c in str(value) if c.isalnum() or c in "-_")[:64]


def handle_write(msg):
    snapshot = msg.get("snapshot") or {}
    profile_id = safe_id(snapshot.get("profileId", ""))
    if not profile_id:
        return {"ok": False, "error": "missing profileId"}

    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    path = SNAPSHOT_DIR / f"{profile_id}.json"
    snapshot["profileId"] = profile_id  # canonicalised
    snapshot.setdefault(
        "updatedAt",
        time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )

    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(snapshot))
    os.replace(tmp, path)
    return {"ok": True}


def handle_read(msg):
    exclude = safe_id(msg.get("excludeProfileId", ""))
    snapshots = []
    if SNAPSHOT_DIR.is_dir():
        for path in sorted(SNAPSHOT_DIR.glob("*.json")):
            try:
                data = json.loads(path.read_text())
            except Exception:
                continue
            if data.get("profileId") == exclude:
                continue
            snapshots.append(data)
    return {"ok": True, "snapshots": snapshots}


def main():
    msg = read_message()
    if msg is None:
        send_message({"ok": False, "error": "empty or oversized input"})
        return
    cmd = msg.get("cmd")
    try:
        if cmd == "write":
            send_message(handle_write(msg))
        elif cmd == "read":
            send_message(handle_read(msg))
        else:
            send_message({"ok": False, "error": f"unknown cmd: {cmd}"})
    except Exception as err:
        send_message({"ok": False, "error": f"{type(err).__name__}: {err}"})


if __name__ == "__main__":
    main()
