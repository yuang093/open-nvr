#!/usr/bin/env python3
"""
ONVIF Camera Analyzer - 查攝影機 ONVIF 能力

Usage:
    python3 analyze.py <ip> <port> <username> <password>

Output: JSON to stdout

Errors logged to stderr but don't block analysis.
"""
import sys
import json
import socket
from urllib.parse import urlparse


NETWORK_TIMEOUT = 5


def log_err(errors, msg):
    errors.append(msg)
    sys.stderr.write(f"[analyze] {msg}\n")


def check_tcp_reachable(ip, port):
    try:
        with socket.create_connection((ip, port), timeout=NETWORK_TIMEOUT):
            return True
    except Exception:
        return False


def run_analysis(ip, port, username, password):
    errors = []
    result = {
        "reachable": False,
        "onvif_supported": False,
        "device_info": None,
        "capabilities": None,
        "services": [],
        "media_profiles": [],
        "event_service": None,
        "motion_event_support": "unknown",
        "errors": errors,
    }

    result["reachable"] = check_tcp_reachable(ip, port)
    if not result["reachable"]:
        log_err(errors, f"TCP {ip}:{port} not reachable")
        return result

    try:
        from onvif import ONVIFCamera
    except ImportError as e:
        log_err(errors, f"onvif package not installed: {e}")
        return result

    try:
        mycam = ONVIFCamera(ip, port, username, password)
    except Exception as e:
        log_err(errors, f"ONVIF connect failed: {e}")
        return result

    result["onvif_supported"] = True

    # DeviceInfo
    try:
        di = mycam.devicemgmt.GetDeviceInformation()
        result["device_info"] = {
            "manufacturer": str(di.Manufacturer) if hasattr(di, 'Manufacturer') else None,
            "model": str(di.Model) if hasattr(di, 'Model') else None,
            "firmwareVersion": str(di.FirmwareVersion) if hasattr(di, 'FirmwareVersion') else None,
            "serialNumber": str(di.SerialNumber) if hasattr(di, 'SerialNumber') else None,
            "hardwareId": str(di.HardwareId) if hasattr(di, 'HardwareId') else None,
        }
    except Exception as e:
        log_err(errors, f"GetDeviceInformation failed: {e}")

    # Capabilities
    try:
        caps = mycam.devicemgmt.GetCapabilities()
        def has_xaddr(c):
            return bool(getattr(c, 'XAddr', None)) if c else False
        result["capabilities"] = {
            "analytics": has_xaddr(getattr(caps, 'Analytics', None)),
            "device": has_xaddr(getattr(caps, 'Device', None)),
            "events": has_xaddr(getattr(caps, 'Events', None)),
            "imaging": has_xaddr(getattr(caps, 'Imaging', None)),
            "media": has_xaddr(getattr(caps, 'Media', None)),
            "ptz": has_xaddr(getattr(caps, 'PTZ', None)),
        }
    except Exception as e:
        log_err(errors, f"GetCapabilities failed: {e}")

    # Services
    try:
        services = mycam.devicemgmt.GetServices({'IncludeCapability': False})
        result["services"] = []
        for svc in services:
            try:
                result["services"].append({
                    "namespace": str(svc.Namespace),
                    "xaddr": str(svc.XAddr),
                    "version": {"major": int(svc.Version.Major), "minor": int(svc.Version.Minor)},
                })
            except Exception:
                pass
    except Exception as e:
        log_err(errors, f"GetServices failed: {e}")

    # Media Profiles
    # The python-onvif-zeep library does NOT auto-create `mycam.media` in
    # update_xaddrs(); only `devicemgmt` and `events` are eager. We have to
    # create it ourselves before accessing it, otherwise we get
    # "'ONVIFCamera' object has no attribute 'media'".
    media_service = None
    try:
        try:
            media_service = mycam.create_media_service()
        except Exception as e:
            log_err(errors, f"create_media_service failed: {e}")
        if media_service is None:
            raise RuntimeError("media service not available")

        profiles = media_service.GetProfiles()
        media_xaddr = None
        for svc in result.get("services", []):
            if "media" in svc["namespace"].lower():
                media_xaddr = svc["xaddr"]
                break
        if not media_xaddr:
            try:
                media_xaddr = media_service.xaddr
            except Exception:
                media_xaddr = None

        for prof in profiles:
            token = str(prof.token)
            name = str(prof.Name) if hasattr(prof, 'Name') else token
            rtsp_url = None
            try:
                stream_setup = {'Stream': 'RTP-Unicast', 'Transport': {'Protocol': 'RTSP'}}
                uri_resp = media_service.GetStreamUri({'StreamSetup': stream_setup, 'ProfileToken': token})
                rtsp_url = str(uri_resp.Uri)
                if '@' not in rtsp_url and username and password:
                    parsed_uri = urlparse(rtsp_url)
                    rtsp_url = f"{parsed_uri.scheme}://{username}:{password}@{parsed_uri.netloc}{parsed_uri.path}"
            except Exception as e:
                log_err(errors, f"GetStreamUri for profile {token} failed: {e}")
            result["media_profiles"].append({"name": name, "token": token, "rtsp_url": rtsp_url})
    except Exception as e:
        log_err(errors, f"GetProfiles failed: {e}")

    # Event service
    motion_support = "unknown"
    try:
        if hasattr(mycam, 'events'):
            try:
                pullpoint = mycam.events.CreatePullPointSubscription({
                    'InitialTerminationTime': 'PT60S',
                    'Filter': {},
                })
                motion_support = "supported"
                result["event_service"] = {
                    "supported": True,
                    "subscription_reference": str(pullpoint.SubscriptionReference) if hasattr(pullpoint, 'SubscriptionReference') else None,
                }
            except Exception as e:
                err_str = str(e).lower()
                if "topic" in err_str or "filter" in err_str:
                    motion_support = "supported"
                    result["event_service"] = {"supported": True, "needs_filter": True}
                else:
                    log_err(errors, f"CreatePullPointSubscription failed: {e}")
                    motion_support = "unsupported"
        else:
            motion_support = "unsupported"
    except Exception as e:
        log_err(errors, f"Event service probe failed: {e}")
    result["motion_event_support"] = motion_support

    return result


def main():
    if len(sys.argv) != 5:
        sys.stderr.write("Usage: analyze.py <ip> <port> <username> <password>\n")
        sys.exit(2)
    ip, port, username, password = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
    try:
        result = run_analysis(ip, port, username, password)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        sys.exit(0)
    except Exception as e:
        sys.stderr.write(f"Fatal: {e}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
