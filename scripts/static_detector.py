#!/usr/bin/env python3
"""Static airplane detection for c3_10_23_40_18 (停機坪).

Every STATIC_CHECK_INTERVAL seconds:
  1. ffmpeg grab 1920x1080 frame from RTSP
  2. POST /detect to live-detector:9999 with enabledClasses filter
  3. feed YOLO detections into IOU tracker
  4. if tracker fires arrived/departed -> call static_event_writer.cjs

Status: GET /status returns last_check, airplane_count, tracks.
"""
from __future__ import annotations
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

# Make scripts package importable
SCRIPTS_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPTS_DIR.parent))

from scripts.iou_tracker import Tracker  # noqa: E402

YOLO_URL = "http://127.0.0.1:9999/detect"
EVENT_WRITER = SCRIPTS_DIR / "static_event_writer.cjs"
NODE_BIN = "/usr/bin/node"

# Global state for /status endpoint
STATE = {
    "last_check": None,
    "last_airplane_count": 0,
    "tracks": [],
    "error": None,
}


def grab_frame(rtsp_url: str, out_path: Path) -> bool:
    """Use ffmpeg to grab 1 frame and save as JPEG. Returns True on success."""
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-rtsp_transport", "tcp",
        "-i", rtsp_url,
        "-frames:v", "1",
        "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
        "-q:v", "2",
        str(out_path),
    ]
    try:
        result = subprocess.run(cmd, timeout=15, capture_output=True, text=True)
        return result.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        print(f"[static_detector] ffmpeg failed: {e}", flush=True)
        return False


def detect_airplanes(image_path: Path, camera_key: str) -> list[dict]:
    """POST image to live-detector, return airplane-shaped detections."""
    import base64
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    payload = {
        "cameraKey": camera_key,
        "image": f"data:image/jpeg;base64,{b64}",
        # Class filter: only aeroplane (class id 4)
        "enabledClasses": "4",
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(YOLO_URL, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        print(f"[static_detector] YOLO failed: {e}", flush=True)
        return []

    bboxes = result.get("bboxes", [])
    # Filter to aeroplane class only (defensive: live-detector may not have filter applied)
    return [
        {"id": f"a{i}", "box": b["box"]}
        for i, b in enumerate(bboxes)
        if "aeroplane" in b.get("object", "").lower()
    ]


def write_event(camera_key: str, camera_name: str, event: str, track_id: str):
    """Invoke Node.js writer to persist event to levelDB."""
    cmd = [
        NODE_BIN, str(EVENT_WRITER),
        "--cameraKey", camera_key,
        "--cameraName", camera_name,
        "--event", event,
        "--trackId", track_id,
    ]
    try:
        result = subprocess.run(cmd, timeout=10, capture_output=True, text=True)
        if result.returncode == 0:
            print(f"[static_detector] event written: {event} {track_id}", flush=True)
        else:
            print(f"[static_detector] event write failed: {result.stderr.strip()}", flush=True)
    except subprocess.TimeoutExpired:
        print(f"[static_detector] event write timeout", flush=True)


def run_cycle(args, tracker: Tracker):
    """One check cycle: grab -> detect -> tracker -> events."""
    out_path = Path("/tmp") / f"static_frame_{int(time.time())}.jpg"
    if not grab_frame(args.rtsp, out_path):
        STATE["error"] = "ffmpeg grab failed"
        return
    STATE["error"] = None

    try:
        dets = detect_airplanes(out_path, args.camera_key)
    finally:
        try:
            out_path.unlink()
        except FileNotFoundError:
            pass

    STATE["last_check"] = time.time()
    STATE["last_airplane_count"] = len(dets)

    events = tracker.update(dets)
    for ev in events:
        write_event(args.camera_key, args.camera, ev["event"], ev["track_id"])

    STATE["tracks"] = [
        {"track_id": tid, "misses": s.get("misses", 0), "pending": s.get("pending", 0)}
        for tid, s in tracker._state.items()
    ]


def make_status_handler():
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/status":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(STATE, indent=2).encode())
            else:
                self.send_response(404)
                self.end_headers()
        def log_message(self, *_):
            pass
    return H


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--camera-key", default=os.environ.get("STATIC_DETECTOR_CAMERA_KEY", "C182220063"))
    p.add_argument("--camera", default=os.environ.get("STATIC_DETECTOR_CAMERA", "c3_10_23_40_18"))
    p.add_argument("--rtsp", default=os.environ.get(
        "STATIC_DETECTOR_RTSP",
        "rtsp://admin:113cctv@10.23.40.18/rtsp/defaultPrimary?streamType=u"))
    p.add_argument("--interval", type=int, default=int(os.environ.get("STATIC_CHECK_INTERVAL", "300")))
    p.add_argument("--port", type=int, default=int(os.environ.get("STATIC_PORT", "9997")))
    p.add_argument("--iou-thresh", type=float, default=0.3)
    p.add_argument("--confirmation-frames", type=int, default=2)
    args = p.parse_args()

    tracker = Tracker(confirmation_frames=args.confirmation_frames)

    print(f"[static_detector] starting: camera={args.camera} interval={args.interval}s port={args.port}", flush=True)

    server = HTTPServer(("127.0.0.1", args.port), make_status_handler())
    print(f"[static_detector] status endpoint: http://127.0.0.1:{args.port}/status", flush=True)

    while True:
        try:
            run_cycle(args, tracker)
        except Exception as e:
            print(f"[static_detector] cycle error: {e}", flush=True)
            STATE["error"] = str(e)
        server.timeout = max(0.1, args.interval / 10)
        server.handle_request()
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
