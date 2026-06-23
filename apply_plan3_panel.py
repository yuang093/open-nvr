"""Single-shot PanelSettings.jsx patcher for plan3.

This script applies all 4 plan3 changes to PanelSettings.jsx in one pass:
1. Add 4 analysis state variables
2. Add analyzeCamera + 2 apply helper functions
3. Add AI Analysis section (Checkbox + Analyze button) before Movement processing
4. Add Analysis result modal as 2nd Dialog in return expression
5. Wrap return in Fragment to support 2 sibling Dialogs
6. Add missing close paren

The script does all 4 insertions as a single string replace, avoiding
the cascading sys.exit problem of install_plan3.py.
"""
import os
import re
import sys
import pathlib

SRC = pathlib.Path(os.path.expanduser('~/open-source-nvr'))
panel_path = SRC / 'src' / 'PanelSettings.jsx'
content = panel_path.read_text()


def replace(old, new, desc):
    global content
    if old not in content:
        print(f"[ERROR] anchor for '{desc}' not found")
        print(f"  looking for: {old!r}")
        sys.exit(1)
    if content.count(old) > 1:
        print(f"[ERROR] anchor for '{desc}' is ambiguous (found {content.count(old)} times)")
        sys.exit(1)
    content = content.replace(old, new, 1)
    print(f"[OK] {desc}")


# 1. Add state variables
replace(
    '    const [diskStatusLoading, setDiskStatusLoading] = React.useState(false)',
    '''    const [diskStatusLoading, setDiskStatusLoading] = React.useState(false)
    const [analyzing, setAnalyzing] = React.useState(false)
    const [analysisResult, setAnalysisResult] = React.useState(null)
    const [analysisError, setAnalysisError] = React.useState(null)
    const [analysisOpen, setAnalysisOpen] = React.useState(false)''',
    'add state variables'
)

# 2. Add analyzeCamera + apply helpers before savePanel
replace(
    '    function savePanel(event, ctx) {',
    '''    async function analyzeCamera() {
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
        if (!analysisResult) return;
        updatePanelValues('motionUrl', 'http://127.0.0.1:9998/motion');
    }

    function applyStreamSourceFromAnalysis() {
        if (!analysisResult || !analysisResult.media_profiles) return;
        const prof = analysisResult.media_profiles.find(p => p.rtsp_url);
        if (prof && prof.rtsp_url) {
            updatePanelValues('streamSource', prof.rtsp_url);
        }
    }

    function savePanel(event, ctx) {''',
    'add analyzeCamera + apply helpers'
)

# 3. Add AI Analysis section before Movement processing
replace(
    '<Divider><b>Movement processing</b></Divider>',
    '''<Divider><b>AI Analysis</b></Divider>

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

                    <Divider><b>Movement processing</b></Divider>''',
    'add AI Analysis section'
)

# 4. Replace the return statement to wrap in Fragment and add modal
# Original:
#   return panel.open && (
#       <Dialog modalType='modal' open={panel.open}>
#       ...
#       </Dialog>
#     )
#
#   }
# }
#
# New:
#   return panel.open && (
#       <>
#       <Dialog modalType='modal' open={panel.open}>
#       ...
#       </Dialog>
#
#       {analysisOpen && (
#           <Dialog modalType='modal' open={analysisOpen}>
#           ... modal content ...
#           </Dialog>
#       )}
#       </>
#     )
#
#   }
# }
old_return = '''    return panel.open && (

      <Dialog modalType='modal' open={panel.open}>
'''
new_return = '''    return panel.open && (

      <>
      <Dialog modalType='modal' open={panel.open}>
'''
replace(old_return, new_return, 'wrap return in Fragment (open)')

# 5. Replace the end - add modal then close Fragment
# Anchor is unique because </Dialog> followed by )} followed by function close }
# The actual file has: `      </Dialog> \n    )\n    \n}` (with trailing space after </Dialog>)
old_end = '''      </Dialog> 
    )
    
}'''
new_end = '''      </Dialog>

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
                            {k}: {v ? 'YES' : 'NO'}
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
                        Camera supports ONVIF motion events. Configure an ONVIF proxy and set Motion Detection URL below.
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
      </>
    )

}'''
replace(old_end, new_end, 'add modal + close Fragment')

panel_path.write_text(content)
print(f"\n[DONE] Patched {panel_path}")
print(f"  Total lines: {len(content.splitlines())}")
