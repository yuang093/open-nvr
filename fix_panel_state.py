"""Patch PanelSettings.jsx to add missing state, function, and Analyze button.

These 3 sections were lost when install_plan3.py failed on closing anchor.
patch_panel_modal.py later added the modal which references `analyzing` etc.
"""
import os
import sys
import pathlib

SRC = pathlib.Path(os.path.expanduser('~/open-source-nvr'))
panel_path = SRC / 'src' / 'PanelSettings.jsx'
content = panel_path.read_text()

# 1. Add state variables after diskStatusLoading
old_state = '    const [diskStatusLoading, setDiskStatusLoading] = React.useState(false)'
new_state = '''    const [diskStatusLoading, setDiskStatusLoading] = React.useState(false)
    const [analyzing, setAnalyzing] = React.useState(false)
    const [analysisResult, setAnalysisResult] = React.useState(null)
    const [analysisError, setAnalysisError] = React.useState(null)
    const [analysisOpen, setAnalysisOpen] = React.useState(false)'''
if old_state not in content:
    print("[fix] ERROR: state anchor not found")
    sys.exit(1)
content = content.replace(old_state, new_state, 1)
print("[fix] Added 4 analysis state variables")

# 2. Add analyzeCamera + apply helpers before savePanel
old_fn = '    function savePanel(event, ctx) {'
helpers = '''    async function analyzeCamera() {
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

    function savePanel(event, ctx) {'''
if old_fn not in content:
    print("[fix] ERROR: savePanel anchor not found")
    sys.exit(1)
content = content.replace(old_fn, helpers, 1)
print("[fix] Added analyzeCamera + apply helpers")

# 3. Add AI Analysis section + Analyze button before Movement processing divider
old_div = '<Divider><b>Movement processing</b></Divider>'
if old_div not in content:
    print("[fix] ERROR: Movement processing divider not found")
    sys.exit(1)
ai_section = '''<Divider><b>AI Analysis</b></Divider>

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
content = content.replace(old_div, ai_section, 1)
print("[fix] Added AI Analysis section + Analyze button")

panel_path.write_text(content)
print(f"[fix] Patched {panel_path}")
