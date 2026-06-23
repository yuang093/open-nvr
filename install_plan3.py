#!/usr/bin/env python3
"""
Plan 3 installer: apply all code changes for analyze-camera + enable_ai features.

Run from: ~/open-source-nvr
After: npm run build && restart NVR
"""
import os
import sys
import pathlib
import re

SRC = pathlib.Path(os.path.expanduser('~/open-source-nvr'))

if not SRC.exists():
    print(f"ERROR: {SRC} not found")
    sys.exit(1)

print(f"[plan3] Working in {SRC}")

# ============================================================================
# 1. Write ai/analyze_camera.py (new file)
# ============================================================================
ANALYZER_SOURCE = r'''#!/usr/bin/env python3
"""
ONVIF Camera Analyzer - 查攝影機 ONVIF 能力

Usage:
    python3 analyze_camera.py <ip> <port> <username> <password>

Output: JSON to stdout
"""
import sys
import json
import socket
from urllib.parse import urlparse

NETWORK_TIMEOUT = 8


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

    from onvif import ONVIFCamera
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
    try:
        profiles = mycam.media.GetProfiles()
        media_xaddr = None
        for svc in result.get("services", []):
            if "media" in svc["namespace"].lower():
                media_xaddr = svc["xaddr"]
                break
        if not media_xaddr:
            try:
                media_xaddr = mycam.media.xaddr
            except Exception:
                media_xaddr = None

        for prof in profiles:
            token = str(prof.token)
            name = str(prof.Name) if hasattr(prof, 'Name') else token
            rtsp_url = None
            try:
                stream_setup = {'Stream': 'RTP-Unicast', 'Transport': {'Protocol': 'RTSP'}}
                uri_resp = mycam.media.GetStreamUri({'StreamSetup': stream_setup, 'ProfileToken': token})
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
        sys.stderr.write("Usage: analyze_camera.py <ip> <port> <username> <password>\n")
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
'''

analyzer_path = SRC / 'ai' / 'analyze_camera.py'
analyzer_path.parent.mkdir(parents=True, exist_ok=True)
analyzer_path.write_text(ANALYZER_SOURCE)
analyzer_path.chmod(0o755)
print(f"[plan3] Wrote {analyzer_path}")


# ============================================================================
# 2. Modify server/www.ts (add enable_ai field + analyze endpoint)
# ============================================================================
www_path = SRC / 'server' / 'www.ts'
www_content = www_path.read_text()

# 2a. Add enable_ai field to CameraEntry
old_field = '    enable_movement: boolean;\n    pollsWithoutMovement: number;'
new_field = ('    enable_movement: boolean;\n'
             '    /** Plan 3: per-camera AI toggle. If false, motion events recorded but YOLO skipped. Default true. */\n'
             '    enable_ai?: boolean;\n'
             '    pollsWithoutMovement: number;')
if old_field not in www_content:
    print(f"[plan3] ERROR: enable_movement anchor not found in www.ts")
    sys.exit(1)
www_content = www_content.replace(old_field, new_field, 1)
print(f"[plan3] Added enable_ai field to CameraEntry")

# 2b. Add /api/camera/:id/analyze endpoint
analyze_endpoint = '''        .post('/camera/:id/analyze', async (ctx) => {
            const cameraKey = ctx.params['id'];
            try {
                const cam: CameraEntry = await cameradb.get(cameraKey);
                if (!cam || cam.delete) {
                    ctx.body = { error: 'Camera not found' };
                    ctx.status = 404;
                    return;
                }
                // Determine IP from streamSource or ip field
                let ipAddr: string | undefined = cam.ip;
                if (!ipAddr && cam.streamSource) {
                    const m = cam.streamSource.match(/@([\\d.]+)/);
                    if (m) ipAddr = m[1];
                }
                if (!ipAddr) {
                    ctx.body = { error: 'No IP address available for this camera' };
                    ctx.status = 400;
                    return;
                }
                const { spawn } = await import('child_process');
                const pathMod = await import('path');
                const analyzerPath = pathMod.join(process.cwd(), 'ai', 'analyze_camera.py');
                const proc = spawn('python3', [
                    analyzerPath, ipAddr, '80', 'admin', cam.passwd || ''
                ]);
                let stdout = '', stderr = '';
                proc.stdout.on('data', d => stdout += d);
                proc.stderr.on('data', d => stderr += d);
                const exitCode: number = await new Promise((resolve) => {
                    const timer = setTimeout(() => {
                        proc.kill('SIGKILL');
                        resolve(-1);
                    }, 30000);
                    proc.on('close', code => {
                        clearTimeout(timer);
                        resolve(code === null ? -1 : code);
                    });
                });
                if (exitCode !== 0 && !stdout) {
                    ctx.body = { error: 'Analyzer failed', stderr, exitCode };
                    ctx.status = 500;
                    return;
                }
                try {
                    const report = JSON.parse(stdout);
                    ctx.body = report;
                } catch (e) {
                    ctx.body = { error: 'Invalid analyzer JSON output', stdout, stderr };
                    ctx.status = 500;
                }
            } catch (e: any) {
                logger.error('Camera analyze error', { error: String(e) });
                ctx.body = { error: String(e) };
                ctx.status = 500;
            }
        })
        .get('/movements/stream', (ctx) => {'''

anchor = "        .get('/movements/stream', (ctx) => {"
if anchor not in www_content:
    print(f"[plan3] ERROR: /movements/stream anchor not found in www.ts")
    sys.exit(1)
www_content = www_content.replace(anchor, analyze_endpoint, 1)
print(f"[plan3] Added /api/camera/:id/analyze endpoint")

www_path.write_text(www_content)
print(f"[plan3] Updated {www_path}")


# ============================================================================
# 3. Modify server/processor.ts (add enable_ai check)
# ============================================================================
proc_path = SRC / 'server' / 'processor.ts'
proc_content = proc_path.read_text()

old_anchor = '    if (cameraEntry.delete) return;  // Camera deleted'
if old_anchor not in proc_content:
    print(f"[plan3] ERROR: delete-check anchor not found in processor.ts")
    sys.exit(1)

enable_ai_block = '''    if (cameraEntry.delete) return;  // Camera deleted

    // Plan 3: skip AI processing if disabled for this camera.
    // Mark pending movements as completed (skipped) and advance pointer.
    if (cameraEntry.enable_ai === false) {
        try {
            const pointer = cameraEntry.state_lastProcessedMovementKey || '0';
            for await (const [encodedKey, movement] of deps.movementdb.iterator({ gt: pointer })) {
                if (movement.cameraKey !== cameraKey) continue;
                if (movement.processing_state !== 'pending') continue;
                const updatedMovement = {
                    ...movement,
                    processing_state: 'completed' as const,
                    detection_status: 'ai_disabled',
                    processing_completed_at: Date.now(),
                };
                await deps.movementdb.put(encodedKey, updatedMovement);
                const currentCam = await deps.cameradb.get(cameraKey);
                if (currentCam) {
                    await deps.cameradb.put(cameraKey, {
                        ...currentCam,
                        state_lastProcessedMovementKey: encodedKey,
                    });
                }
                const camCache = deps.getCameraCache()[cameraKey];
                if (camCache) {
                    deps.setCameraCache(cameraKey, {
                        ...camCache,
                        cameraEntry: {
                            ...camCache.cameraEntry,
                            state_lastProcessedMovementKey: encodedKey,
                        }
                    });
                }
                deps.logger.info('triggerProcessMovement: AI disabled - movement recorded without detection', {
                    camera: cameraEntry.name,
                    movement_key: encodedKey,
                });
                if (sseManager.getClientCount() > 0) {
                    sseManager.broadcastMovementUpdate({
                        type: 'movement_update',
                        movement: formatMovementForSSE(encodedKey, updatedMovement)
                    });
                }
                break;
            }
        } catch (e) {
            deps.logger.error('triggerProcessMovement: failed to skip AI-disabled movement', {
                cameraKey,
                error: String(e)
            });
        }
        return;
    }'''

proc_content = proc_content.replace(old_anchor, enable_ai_block, 1)
print(f"[plan3] Added enable_ai check to triggerProcessMovement")

proc_path.write_text(proc_content)
print(f"[plan3] Updated {proc_path}")


# ============================================================================
# 4. Modify src/PanelSettings.jsx (add analyze button + AI switch)
# ============================================================================
panel_path = SRC / 'src' / 'PanelSettings.jsx'
panel_content = panel_path.read_text()

# 4a. Add Spinner already imported, but ensure we have all needed imports
# Spinner is already in the import list

# 4b. Add state + handlers near the top of PanelSettings component
state_block = '''    const [error, setError] = React.useState(null)
    const [diskStatus, setDiskStatus] = React.useState(null)
    const [diskStatusLoading, setDiskStatusLoading] = React.useState(false)
    const [analyzing, setAnalyzing] = React.useState(false)
    const [analysisResult, setAnalysisResult] = React.useState(null)
    const [analysisError, setAnalysisError] = React.useState(null)
    const [analysisOpen, setAnalysisOpen] = React.useState(false)'''
old_state = '    const [error, setError] = React.useState(null)\n    const [diskStatus, setDiskStatus] = React.useState(null)\n    const [diskStatusLoading, setDiskStatusLoading] = React.useState(false)'
if old_state not in panel_content:
    print(f"[plan3] ERROR: state anchor not found in PanelSettings.jsx")
    sys.exit(1)
panel_content = panel_content.replace(old_state, state_block, 1)
print(f"[plan3] Added analysis state variables")

# 4c. Add analyzeCamera function before savePanel
analyze_fn = '''    async function analyzeCamera() {
        if (!panel.values.key) return;
        setAnalyzing(true);
        setAnalysisError(null);
        setAnalysisResult(null);
        setAnalysisOpen(true);
        try {
            const res = await fetch(`/api/camera/${panel.values.key}/analyze`, {
                method: 'POST',
                credentials: 'same-origin',
            });
            const data = await res.json();
            if (!res.ok) {
                setAnalysisError(data.error || `HTTP ${res.status}`);
            } else {
                setAnalysisResult(data);
            }
        } catch (e) {
            setAnalysisError(String(e));
        } finally {
            setAnalyzing(false);
        }
    }

    function applyMotionUrlFromAnalysis() {
        if (!analysisResult || !analysisResult.media_profiles) return;
        // Prefer first profile with RTSP URL
        const prof = analysisResult.media_profiles.find(p => p.rtsp_url);
        if (prof && prof.rtsp_url) {
            // For ONVIF proxy setup, use localhost:9998 placeholder
            // User needs to start the proxy separately
            updatePanelValues('motionUrl', 'http://127.0.0.1:9998/motion');
        }
    }

    function applyStreamSourceFromAnalysis() {
        if (!analysisResult || !analysisResult.media_profiles) return;
        const prof = analysisResult.media_profiles.find(p => p.rtsp_url);
        if (prof && prof.rtsp_url) {
            updatePanelValues('streamSource', prof.rtsp_url);
        }
    }

    function savePanel(event, ctx) {'''
panel_content = panel_content.replace('    function savePanel(event, ctx) {', analyze_fn, 1)
print(f"[plan3] Added analyzeCamera + apply helpers")

# 4d. Add Analyze button + AI switch in the camera form
# Insert before the Divider with "Movement processing"
old_movement_div = '<Divider><b>Movement processing</b></Divider>'
if old_movement_div not in panel_content:
    print(f"[plan3] ERROR: Movement processing divider not found")
    sys.exit(1)

new_movement_section = '''<Divider><b>AI Analysis</b></Divider>

                    <Checkbox label="Enable AI Analysis (YOLO object detection)" checked={panel.values.enable_ai !== false} onChange={(_,data) => updatePanelValues('enable_ai', data.checked)} />

                    <Field label="Analyze Camera (ONVIF capability discovery)">
                      <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                        <Button appearance="subtle" disabled={!panel.values.key || analyzing} onClick={analyzeCamera}>
                          {analyzing ? 'Analyzing...' : 'Analyze Camera'}
                        </Button>
                        {analyzing && <Spinner size="tiny" />}
                        <Text size={200} style={{color: '#666'}}>
                          Discover ONVIF capabilities, RTSP URLs, motion event support
                        </Text>
                      </div>
                    </Field>

                    <Divider><b>Movement processing</b></Divider>'''

panel_content = panel_content.replace(old_movement_div, new_movement_section, 1)
print(f"[plan3] Added AI Analysis section + Analyze button")

# 4e. Add Analysis Result Modal - insert after the main Dialog closing
# Find the end of the main Dialog and add a new Dialog after it
# Pattern: closing </DialogSurface> followed by </Dialog>
old_close = '      </Dialog>\n    )\n    \n}'
new_close = '''      </Dialog>

      {analysisOpen && (
        <Dialog modalType='modal' open={analysisOpen}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Camera Analysis Result</DialogTitle>
              <DialogContent className={styles.base}>
                {analyzing && (
                  <div style={{display: 'flex', alignItems: 'center', gap: '8px', padding: '20px'}}>
                    <Spinner />
                    <Text>Querying camera ONVIF capabilities...</Text>
                  </div>
                )}
                {analysisError && (
                  <Alert intent='error'>{analysisError}</Alert>
                )}
                {analysisResult && (
                  <>
                    <Field label="Reachable">
                      <Badge appearance="filled" color={analysisResult.reachable ? 'success' : 'danger'}>
                        {analysisResult.reachable ? 'Yes' : 'No'}
                      </Badge>
                    </Field>
                    <Field label="ONVIF Supported">
                      <Badge appearance="filled" color={analysisResult.onvif_supported ? 'success' : 'warning'}>
                        {analysisResult.onvif_supported ? 'Yes' : 'No'}
                      </Badge>
                    </Field>
                    {analysisResult.device_info && (
                      <div style={{border: '1px solid #e0e0e0', borderRadius: '4px', padding: '12px', marginBottom: '12px'}}>
                        <Text weight="semibold" block>Device Information</Text>
                        <Text block>Manufacturer: {analysisResult.device_info.manufacturer || 'N/A'}</Text>
                        <Text block>Model: {analysisResult.device_info.model || 'N/A'}</Text>
                        <Text block>Firmware: {analysisResult.device_info.firmwareVersion || 'N/A'}</Text>
                        <Text block>Serial: {analysisResult.device_info.serialNumber || 'N/A'}</Text>
                      </div>
                    )}
                    {analysisResult.capabilities && (
                      <div style={{border: '1px solid #e0e0e0', borderRadius: '4px', padding: '12px', marginBottom: '12px'}}>
                        <Text weight="semibold" block>Capabilities</Text>
                        {Object.entries(analysisResult.capabilities).map(([k, v]) => (
                          <Badge key={k} appearance="outline" color={v ? 'success' : 'subtle'} style={{marginRight: '4px'}}>
                            {k}: {v ? '✓' : '✗'}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {analysisResult.media_profiles && analysisResult.media_profiles.length > 0 && (
                      <div style={{border: '1px solid #e0e0e0', borderRadius: '4px', padding: '12px', marginBottom: '12px'}}>
                        <Text weight="semibold" block>Media Profiles (RTSP URLs)</Text>
                        {analysisResult.media_profiles.map((p, idx) => (
                          <div key={idx} style={{marginTop: '8px', padding: '8px', background: '#f9f9f9', borderRadius: '4px'}}>
                            <Text block weight="semibold">{p.name} ({p.token})</Text>
                            <Text block size={200} style={{fontFamily: 'monospace', wordBreak: 'break-all'}}>
                              {p.rtsp_url || '(URL not available)'}
                            </Text>
                          </div>
                        ))}
                      </div>
                    )}
                    <Field label="Motion Event Support">
                      <Badge appearance="filled" color={
                        analysisResult.motion_event_support === 'supported' ? 'success' :
                        analysisResult.motion_event_support === 'unsupported' ? 'danger' : 'warning'
                      }>
                        {analysisResult.motion_event_support}
                      </Badge>
                    </Field>
                    {analysisResult.motion_event_support === 'supported' && (
                      <Alert intent="info">
                        Camera supports ONVIF motion events. Configure an ONVIF proxy (e.g., onvif2reolink) and set Motion Detection URL below.
                      </Alert>
                    )}
                    {analysisResult.errors && analysisResult.errors.length > 0 && (
                      <Alert intent='warning'>
                        Warnings: {analysisResult.errors.join('; ')}
                      </Alert>
                    )}
                  </>
                )}
              </DialogContent>
              <DialogActions>
                {analysisResult && analysisResult.media_profiles && analysisResult.media_profiles.some(p => p.rtsp_url) && (
                  <>
                    <Button appearance="subtle" onClick={applyStreamSourceFromAnalysis}>Apply RTSP URL</Button>
                    {analysisResult.motion_event_support === 'supported' && (
                      <Button appearance="subtle" onClick={applyMotionUrlFromAnalysis}>Set Motion URL (proxy)</Button>
                    )}
                  </>
                )}
                <Button appearance="primary" onClick={() => setAnalysisOpen(false)}>Close</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    }

}'''
if old_close not in panel_content:
    print(f"[plan3] ERROR: closing anchor not found in PanelSettings.jsx")
    sys.exit(1)
panel_content = panel_content.replace(old_close, new_close, 1)
print(f"[plan3] Added analysis result modal")

panel_path.write_text(panel_content)
print(f"[plan3] Updated {panel_path}")


# ============================================================================
# Done
# ============================================================================
print("")
print("[plan3] All changes applied. Next steps:")
print("  cd ~/open-source-nvr")
print("  npm run build")
print("  pkill -f 'lib/server/index.js'")
print("  nohup node lib/server/index.js > ~/nvr.log 2>&1 &")
