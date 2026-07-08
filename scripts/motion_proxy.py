#!/usr/bin/env python3
import os, sys, time, threading, subprocess, signal
import cv2
import numpy as np
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

HTTP_PORT = 9998
HTTP_HOST = "127.0.0.1"
COOLDOWN_SEC = 3.0
FRAME_INTERVAL_SEC = 1.0
DIFF_THRESHOLD = int(os.environ.get('DIFF_THRESHOLD', '1000'))

CAMERAS = {
    "p4-car":      "rtsp://admin:@113cctv@192.168.133.105/rtsp/defaultPrimary?streamType=u",
    "10_23_12_44": "rtsp://admin:%40113cctv@10.23.12.44/rtsp/defaultPrimary?streamType=u",
    "c3_10_23_40_18": "rtsp://admin:113cctv@10.23.40.18/rtsp/defaultPrimary?streamType=u",
}

motion_state = {name: {"motion": False, "last_motion_time": 0} for name in CAMERAS}

def grab_frame_ffmpeg(name, url):
    cmd = ["ffmpeg", "-rtsp_transport", "tcp", "-y", "-timeout", "8000000",
           "-i", url, "-frames:v", "1", "-f", "image2", "-"]
    try:
        import time as _time
        t0 = _time.time()
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, stderr = proc.communicate(timeout=30)
        elapsed = _time.time() - t0
        if proc.returncode != 0 or not stdout:
            print(f"[{name}] grab failed rc={proc.returncode} after {elapsed:.1f}s", flush=True)
            return False, None
        frame = cv2.imdecode(np.frombuffer(stdout, np.uint8), cv2.IMREAD_COLOR)
        print(f"[{name}] grab OK {elapsed:.1f}s {len(stdout)} bytes frame={frame.shape if frame is not None else None}", flush=True)
        return frame is not None, frame
    except Exception as e:
        print(f"[{name}] grab exception: {e}", flush=True)
        return False, None

def camera_worker(name, url):
    print(f"[{name}] starting worker", flush=True)
    last_frame = None
    while True:
        try:
            ok, frame = grab_frame_ffmpeg(name, url)
            if not ok or frame is None:
                print(f"[{name}] ffmpeg grab failed, retry in 5s", flush=True)
                time.sleep(5)
                continue
            small = cv2.resize(frame, (160, 120))
            if last_frame is None:
                last_frame = small
                time.sleep(FRAME_INTERVAL_SEC)
                continue
            diff = cv2.absdiff(small, last_frame)
            changed = int(np.sum(diff > 10))
            last_frame = small
            now = time.time()
            if changed > DIFF_THRESHOLD:
                motion_state[name]["motion"] = True
                motion_state[name]["last_motion_time"] = now
                print(f"[{name}] MOTION detected (diff={changed})", flush=True)
            elif now - motion_state[name]["last_motion_time"] > COOLDOWN_SEC:
                print(f"[{name}] diff={changed}", flush=True)
                motion_state[name]["motion"] = False
        except Exception as e:
            print(f"[{name}] error: {e}", flush=True)
            time.sleep(5)
        time.sleep(FRAME_INTERVAL_SEC)

class MotionHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return
    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        camera = qs.get("camera", [None])[0]
        if not camera or camera not in motion_state:
            self.send_response(400); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(b"{\"error\":\"unknown camera\"}"); return
        is_motion = motion_state[camera]["motion"]
        if time.time() < motion_state[camera].get("manual_until", 0):
            is_motion = True
        import json
        payload = [{"cmd": "GetMdState", "code": 0, "value": {"state": 1 if is_motion else 0, "time": int(time.time())}}]
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps(payload).encode("utf-8"))
    def do_POST(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        camera = qs.get("camera", [None])[0]
        duration = int(qs.get("seconds", ["60"])[0])
        if not camera or camera not in motion_state:
            self.send_response(400); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(b"{\"error\":\"unknown camera\"}"); return
        motion_state[camera]["manual_until"] = time.time() + duration
        print(f"[trigger] {camera} motion=True for {duration}s", flush=True)
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(f"{{\"ok\":true,\"camera\":\"{camera}\",\"seconds\":{duration}}}".encode())

def main():
    print("Starting Motion Proxy", flush=True)
    for name, url in CAMERAS.items():
        t = threading.Thread(target=camera_worker, args=(name, url), daemon=True)
        t.start()
    server = HTTPServer((HTTP_HOST, HTTP_PORT), MotionHandler)
    print(f"HTTP server on http://{HTTP_HOST}:{HTTP_PORT}/motion", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == "__main__":
    main()
