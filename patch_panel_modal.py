#!/usr/bin/env python3
"""Patch PanelSettings.jsx to add analysis result modal (the part that failed)."""
import os
import sys
import pathlib

SRC = pathlib.Path(os.path.expanduser('~/open-source-nvr'))

panel_path = SRC / 'src' / 'PanelSettings.jsx'
content = panel_path.read_text()

# Correct anchor: </Dialog> has a trailing space
old_close = '      </Dialog> \n    )\n    \n}'
if old_close not in content:
    print(f"[patch] ERROR: anchor not found")
    print(f"[patch] Looking for: {repr(old_close)}")
    # Show last 200 chars
    print(f"[patch] Last 200 chars of file:")
    print(repr(content[-200:]))
    sys.exit(1)

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
    }

}'''

content = content.replace(old_close, new_close, 1)
panel_path.write_text(content)
print(f"[patch] Added analysis result modal to {panel_path}")
