#!/usr/bin/env python3
"""
Motion detection proxy for Avigilon cameras (no ONVIF motion event API).
- Dynamically loads camera list from NVR server REST API
- Falls back to CAMERAS_JSON env var or hardcoded CAMERAS if API unavailable
- Polls every 30s for camera config changes (add/remove)
"""
import os, sys, time, threading, subprocess, signal, json
import cv2
import numpy as np
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
from urllib.request import urlopen, Request
from urllib.error import URLError

HTTP_PORT = 9998
HTTP_HOST = "127.0.0.1"
COOLDOWN_SEC = 3.0
FRAME_INTERVAL_SEC = 1.0
DIFF_THRESHOLD = int(os.environ.get('DIFF_THRESHOLD', '1000'))
NVR_API_URL = os.environ.get('NVR_API_URL', 'http://127.0.0.1:8080/api/cameras/config')
CONFIG_POLL_INTERVAL = int(os.environ.get('CONFIG_POLL_INTERVAL', '30'))

# Fallback hardcoded CAMERAS (used only if API and env CAMERAS_JSON both fail)
CAMERAS_FALLBACK = {
    "p4-car":      "rtsp://admin:@113cctv@192.168.133.105/rtsp/defaultPrimary?streamType=u",
    "10_23_12_44": "rtsp://admin:%40113cctv@10.23.12.44/rtsp/defaultPrimary?streamType=u",
    "c3_10_23_40_18": "rtsp://admin:113cctv@10.23.40.18/rtsp/defaultPrimary?streamType=u",
}

# Global state
camera_workers = {}  # name -> Thread
camera_urls = {}     # name -> RTSP URL
motion_state = {}    # name -> {"motion": bool, "last_motion_time": float, "manual_until": float}
config_lock = threading.Lock()


def fetch_cameras_from_api():
    """Fetch camera list from NVR server REST API."""
    try:
        req = Request(NVR_API_URL, headers={'Accept': 'application/json'})
        with urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            result = {}
            for cam in data.get('cameras', []):
                if not cam.get('enable_streaming', True):
                    continue
                result[cam['name']] = cam['streamSource']
            return result, None
    except (URLError, json.JSONDecodeError, KeyError) as e:
        return None, f"API fetch failed: {e}"


def fetch_cameras_from_env():
    """Fallback: read CAMERAS_JSON env var."""
    raw = os.environ.get('CAMERAS_JSON')
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        return None


def get_cameras():
    """Get current camera list. Tries API first, then env var, then hardcoded."""
    cams, err = fetch_cameras_from_api()
    if cams is not None:
        return cams, 'api'
    cams = fetch_cameras_from_env()
    if cams is not None:
        return cams, 'env'
    return dict(CAMERAS_FALLBACK), 'fallback'


def grab_frame_ffmpeg(name, url):
    cmd = ["ffmpeg", "-rtsp_transport", "tcp", "-y", "-timeout", "8000000",
           "-i", url, "-frames:v", "1", "-f", "image2", "-"]
    try:
        t0 = time.time()
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, stderr = proc.communicate(timeout=30)
        elapsed = time.time() - t0
        if proc.returncode != 0 or not stdout:
            return False, None
        frame = cv2.imdecode(np.frombuffer(stdout, np.uint8), cv2.IMREAD_COLOR)
        return frame is not None, frame
    except Exception as e:
        print(f"[{name}] grab exception: {e}", flush=True)
        return False, None


def camera_worker(name, url):
    print(f"[{name}] starting worker (url={url[:60]}...)", flush=True)
    last_frame = None
    while True:
        # Check if this worker should still be running
        with config_lock:
            current_url = camera_urls.get(name)
        if current_url != url:
            print(f"[{name}] config changed, stopping worker", flush=True)
            return
        try:
            ok, frame = grab_frame_ffmpeg(name, url)
            if not ok or frame is None:
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
                with config_lock:
                    if name in motion_state:
                        motion_state[name]["motion"] = True
                        motion_state[name]["last_motion_time"] = now
                print(f"[{name}] MOTION detected (diff={changed})", flush=True)
            elif now - motion_state[name].get("last_motion_time", 0) > COOLDOWN_SEC:
                with config_lock:
                    if name in motion_state:
                        motion_state[name]["motion"] = False
                if name in os.environ.get('DEBUG_CAMERAS', '').split(','):
                    print(f"[{name}] diff={changed}", flush=True)
        except Exception as e:
            print(f"[{name}] error: {e}", flush=True)
            time.sleep(5)
        time.sleep(FRAME_INTERVAL_SEC)


def reconcile_cameras(new_cameras):
    """Start/stop workers based on new camera set. Returns (added, removed) names."""
    global camera_workers, camera_urls, motion_state
    with config_lock:
        old_names = set(camera_workers.keys())
        new_names = set(new_cameras.keys())
        added = new_names - old_names
        removed = old_names - new_names

        # Stop removed workers
        for name in removed:
            t = camera_workers.pop(name, None)
            if t and t.is_alive():
                # Worker checks camera_urls and exits itself
                pass
            camera_urls.pop(name, None)
            motion_state.pop(name, None)
            print(f"[config] removed camera: {name}", flush=True)

        # Start new workers
        for name in added:
            url = new_cameras[name]
            camera_urls[name] = url
            motion_state[name] = {"motion": False, "last_motion_time": 0, "manual_until": 0}
            t = threading.Thread(target=camera_worker, args=(name, url), daemon=True)
            t.start()
            camera_workers[name] = t
            print(f"[config] added camera: {name}", flush=True)

        # Update URL for existing cameras (in case RTSP changed)
        for name in old_names & new_names:
            new_url = new_cameras[name]
            if camera_urls.get(name) != new_url:
                # URL changed; restart worker by removing and re-adding
                print(f"[config] URL changed for {name}, restarting worker", flush=True)
                old_thread = camera_workers.pop(name)
                camera_urls[name] = new_url
                t = threading.Thread(target=camera_worker, args=(name, new_url), daemon=True)
                t.start()
                camera_workers[name] = t

    return added, removed


def config_watcher():
    """Background thread that polls NVR API for camera config changes."""
    last_source = None
    poll_count = 0
    while True:
        try:
            new_cams, source = get_cameras()
            if source != last_source:
                print(f"[config] using source: {source} ({len(new_cams)} cameras)", flush=True)
                last_source = source
            added, removed = reconcile_cameras(new_cams)
            poll_count += 1
            if added or removed:
                print(f"[config] poll #{poll_count}: +{added} -{removed} total={len(new_cams)}", flush=True)
            elif poll_count % 6 == 0:  # heartbeat every ~3min (6 * 30s)
                print(f"[config] heartbeat poll #{poll_count} stable {len(new_cams)} cameras", flush=True)
        except Exception as e:
            print(f"[config] error: {e}", flush=True)
        time.sleep(CONFIG_POLL_INTERVAL)


class MotionHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return
    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        camera = qs.get("camera", [None])[0]
        with config_lock:
            if not camera or camera not in motion_state:
                self.send_response(400); self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(b'{"error":"unknown camera"}'); return
            is_motion = motion_state[camera]["motion"]
            if time.time() < motion_state[camera].get("manual_until", 0):
                is_motion = True
        payload = [{"cmd": "GetMdState", "code": 0, "value": {"state": 1 if is_motion else 0, "time": int(time.time())}}]
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps(payload).encode("utf-8"))
    def do_POST(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        camera = qs.get("camera", [None])[0]
        duration = int(qs.get("seconds", ["60"])[0])
        with config_lock:
            if not camera or camera not in motion_state:
                self.send_response(400); self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(b'{"error":"unknown camera"}'); return
            motion_state[camera]["manual_until"] = time.time() + duration
        print(f"[trigger] {camera} motion=True for {duration}s", flush=True)
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(f'{{"ok":true,"camera":"{camera}","seconds":{duration}}}'.encode())


def main():
    print(f"Starting Motion Proxy (API: {NVR_API_URL})", flush=True)
    # Initial fetch + reconcile (don't wait for first poll cycle)
    new_cams, source = get_cameras()
    print(f"[config] initial source: {source} ({len(new_cams)} cameras)", flush=True)
    reconcile_cameras(new_cams)
    # Start background config watcher
    watcher = threading.Thread(target=config_watcher, daemon=True)
    watcher.start()
    # Start HTTP server
    server = HTTPServer((HTTP_HOST, HTTP_PORT), MotionHandler)
    print(f"HTTP server on http://{HTTP_HOST}:{HTTP_PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()