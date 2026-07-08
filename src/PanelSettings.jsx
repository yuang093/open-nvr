import React  from 'react';

import {
  Text, 
  Select,
  Dropdown,
  Divider,
  Input,
  Checkbox,
  Slider,
  makeStyles,
  tokens,
  useId,
  Label,
  Badge,
  Textarea,
  shorthands,
  Combobox,
  Option,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogTrigger,
  DialogBody,
  Button,
  Menu,
  MenuTrigger,
  SplitButton,
  MenuList,
  MenuItem,
  MenuPopover,
  Field,
  Spinner
} from "@fluentui/react-components";
import { Alert } from '@fluentui/react-components/unstable';
import { Dismiss12Regular, Folder16Regular, KeyCommand16Regular, Camera16Regular, NetworkAdapter16Regular, Password16Regular } from "@fluentui/react-icons";


const useStyles = makeStyles({
  base: {
    display: "flex",
    flexDirection: "column",
    rowGap: tokens.spacingVerticalS,
    "& > label": {
      marginBottom: tokens.spacingVerticalMNudge,
    },
  },
  root: {
    // Stack the label above the field with a gap
    display: "grid",
    gridTemplateRows: "repeat(1fr)",
    justifyItems: "start",
    ...shorthands.gap("2px"),
    //maxWidth: "400px",
    marginTop: "15px" 
  },
  tagsList: {
    listStyleType: "none",
    marginBottom: tokens.spacingVerticalXXS,
    marginTop: 0,
    paddingLeft: 0,
    display: "flex",
    gridGap: tokens.spacingHorizontalXXS,
  },
});

export const MultiselectWithTags = ({label, options, selectedOptions, setSelectedOptions}) => {
  // generate ids for handling labelling
  const comboId = useId("combo-multi");
  const selectedListId = `${comboId}-selection`;

  // refs for managing focus when removing tags
  const selectedListRef = React.useRef(null);
  const comboboxInputRef = React.useRef(null);

  const styles = useStyles();

  // Handle selectedOptions both when an option is selected or deselected in the Combobox,
  // and when an option is removed by clicking on a tag
  //const [selectedOptions, setSelectedOptions] = React.useState<string[]>([]);

  const onSelect = (event, data) => {
    setSelectedOptions(data.selectedOptions);
  };

  const onTagClick = (option, index) => {
    // remove selected option
    setSelectedOptions(selectedOptions.filter((o) => o !== option));

    // focus previous or next option, defaulting to focusing back to the combo input
    const indexToFocus = index === 0 ? 1 : index - 1;
    const optionToFocus = selectedListRef.current?.querySelector(
      `#${comboId}-remove-${indexToFocus}`
    );
    if (optionToFocus) {
      (optionToFocus).focus();
    } else {
      comboboxInputRef.current?.focus();
    }
  };

  const labelledBy =
    selectedOptions.length > 0 ? `${comboId} ${selectedListId}` : comboId;

  return (
    <div className={styles.root}>
      <Label id={comboId}>{label}</Label>
      {selectedOptions.length ? (
        <ul
          id={selectedListId}
          className={styles.tagsList}
          ref={selectedListRef}
        >
          {/* The "Remove" span is used for naming the buttons without affecting the Combobox name */}
          <span id={`${comboId}-remove`} hidden>
            Remove
          </span>
          {selectedOptions.map((option, i) => (
            <li key={option}>
              <Button
                size="small"
                shape="circular"
                appearance="primary"
                icon={<Dismiss12Regular />}
                iconPosition="after"
                onClick={() => onTagClick(option, i)}
                id={`${comboId}-remove-${i}`}
                aria-labelledby={`${comboId}-remove ${comboId}-remove-${i}`}
              >
                {option}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Combobox
        aria-labelledby={labelledBy}
        multiselect={true}
        placeholder="Select one or more tags"
        selectedOptions={selectedOptions}
        onOptionSelect={onSelect}
        ref={comboboxInputRef}
      >
        {options.map((option) => (
          <Option key={option}>{option}</Option>
        ))}
      </Combobox>
    </div>
  );
};

export const MySplitButton = ({label, items}) => (
  <Menu positioning="below-end">
    <MenuTrigger disableButtonEnhancement>
      {(triggerProps) => (
        <SplitButton menuButton={triggerProps}>{label}</SplitButton>
      )}
    </MenuTrigger>

    <MenuPopover>
      <MenuList>
        { items.map((i, idx) =>
          <MenuItem key={idx} onClick={(event) => i.onClick(event, {key: i.key})}>{i.text}</MenuItem>  
        )}
        
      </MenuList>
    </MenuPopover>
  </Menu>
);


export function PanelSettings({panel, setPanel, data, getServerData}) {

    const [error, setError] = React.useState(null)
    const [diskStatus, setDiskStatus] = React.useState(null)
    const [diskStatusLoading, setDiskStatusLoading] = React.useState(false)
    const [analyzing, setAnalyzing] = React.useState(false)
    const [analysisResult, setAnalysisResult] = React.useState(null)
    const [analysisError, setAnalysisError] = React.useState(null)
    const [analysisOpen, setAnalysisOpen] = React.useState(false)
    // Global AI detection class filter. Mirrors Settings.aiEnabledClasses.
    // Only meaningful for editing on the settings panel (not a specific camera).
    const [globalClasses, setGlobalClasses] = React.useState(null)  // { individual: [], others: bool } | null
    const [globalClassesDirty, setGlobalClassesDirty] = React.useState(false)
    const [globalClassesSaving, setGlobalClassesSaving] = React.useState(false)
    // Per-camera class filter override. Mirrors CameraEntry.enabledClasses.
    // null = use global. {individual:[], others:false} = explicit empty.
    const [cameraClasses, setCameraClasses] = React.useState(null)

    const styles = useStyles();

    // Fetch disk status when settings panel opens
    React.useEffect(() => {
        if (panel.open && panel.key === 'settings') {
            setDiskStatusLoading(true)
            fetch('/api/diskstatus')
                .then(res => res.json())
                .then(data => {
                    setDiskStatus(data)
                    setDiskStatusLoading(false)
                })
                .catch(err => {
                    console.error('Failed to fetch disk status', err)
                    setDiskStatusLoading(false)
                })
        }
    }, [panel.open, panel.key])

    // Sync global class filter from server data when panel opens / data refreshes
    React.useEffect(() => {
        if (panel.open) {
            const g = data?.config?.settings?.aiEnabledClasses;
            if (g) setGlobalClasses({ individual: g.individual || [], others: !!g.others });
        }
    }, [panel.open, data?.config?.settings?.aiEnabledClasses]);

    // Sync per-camera class filter when a different camera is selected
    React.useEffect(() => {
        if (panel.open && panel.key) {
            // panel.values.enabledClasses holds the per-camera override (null = use global)
            const c = panel.values?.enabledClasses;
            if (c) setCameraClasses({ individual: c.individual || [], others: !!c.others });
            else setCameraClasses(null);
        }
    }, [panel.open, panel.key, panel.values?.enabledClasses]);

    const INDIVIDUAL_CLASSES = [
        { id: 0, label: 'person' },
        { id: 1, label: 'bicycle' },
        { id: 2, label: 'car' },
        { id: 3, label: 'motorcycle' },
        { id: 4, label: 'airplane' },
        { id: 5, label: 'bus' },
        { id: 6, label: 'train' },
        { id: 7, label: 'truck' },
        { id: 8, label: 'boat' },
    ];

    function toggleIndividual(setClasses, current, classId) {
        const ind = current?.individual || [];
        const next = ind.includes(classId) ? ind.filter(x => x !== classId) : [...ind, classId];
        setClasses({ ...(current || { individual: [], others: true }), individual: next });
    }

    function toggleOthers(setClasses, current) {
        setClasses({ ...(current || { individual: [], others: true }), others: !current?.others });
    }

    async function saveGlobalClasses() {
        if (!globalClasses) return;
        setGlobalClassesSaving(true);
        try {
            const newSettings = { ...data.config.settings, aiEnabledClasses: globalClasses };
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newSettings),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setGlobalClassesDirty(false);
            if (getServerData) await getServerData();
        } catch (e) {
            console.error('saveGlobalClasses failed', e);
            alert('Save failed: ' + e.message);
        } finally {
            setGlobalClassesSaving(false);
        }
    }

    function saveCameraClasses() {
        // null means "use global default" — store as null (not an empty object)
        // so the resolver falls through to Settings.aiEnabledClasses.
        updatePanelValues('enabledClasses', cameraClasses);
    }

    function updatePanelValues(field, value) {
        console.log (`updatePanelValues ${field} ${JSON.stringify(value)}`)
        var calcFolder = panel.values.folder || ''
        if (field === "name") {
          if (!calcFolder) {
            calcFolder = value
          } else if (calcFolder.includes(panel.values.name)) {
            calcFolder = calcFolder.replace(panel.values.name, value)
          }
        }
    
    
        setPanel({...panel, values: {...panel.values, 
          [field]: value, 
          ...(field === "enable_streaming" && value === false && {enable_movement: false}),
          ...(field !== 'folder' && panel.key !== 'settings' && {folder: calcFolder})
        }})
    }

    function getError(field) {
        const idx = panel.invalidArray.findIndex(e => e.field === field)
        return idx >= 0 ? panel.invalidArray[idx].message : ''
    }

    function invalidFn(field, invalid, message) {
        const e = panel.invalidArray.find(e => e.field === field)
        if (!invalid && e) {
          setPanel((prev) => {return {...prev, invalidArray: prev.invalidArray.filter((e) => e.field !== field)}})
        } else if (invalid && !e) {
          setPanel((prev) => {return {...prev, invalidArray: prev.invalidArray.concat({ field, message })}})
        }
      }
    
      if (panel.open) {
    
        if (panel.key === 'settings') {
          invalidFn('disk_base_dir', !panel.values.disk_base_dir || panel.values.disk_base_dir.endsWith('/') || !panel.values.disk_base_dir.startsWith('/'),
            <Text>Must be abosolute path (cannot end with '/')</Text>)
          invalidFn('detection_model', panel.values.detection_enable && (!panel.values.detection_model),
            <Text>Must select a model for object detection</Text>)
          invalidFn('detection_frames_path', panel.values.detection_enable && panel.values.detection_frames_path && (panel.values.detection_frames_path.endsWith('/')),
            <Text>Frames path cannot end with '/'</Text>)
        } else {
          invalidFn('name', !panel.values.name || panel.values.name.match(/^[a-z0-9][_\-a-z0-9]+[a-z0-9]$/i) === null || panel.values.name.length > 19,
            <Text>Enter valid camera name</Text>)
    
          invalidFn('disk', !panel.values.disk ,
            <Text>Require a Disk to store the files on, goto General Settings to create</Text>)
    
          invalidFn('folder', !panel.values.folder || panel.values.folder.startsWith('/') || panel.values.folder.endsWith('/'),
            <Text>Require a folder to store the files for this camera (relitive to disk, don't start with '/')</Text>)
    
            if (panel.key === "new") {
            invalidFn('ip', !panel.values.ip || panel.values.ip.match(/^([0-9]{1,3}\.){3}[0-9]{1,3}$/i) === null,
              <Text>Enter valid camera IPv4 address</Text>)
          } else {
            invalidFn('ip', panel.values.ip && panel.values.ip.match(/^([0-9]{1,3}\.){3}[0-9]{1,3}$/i) === null,
              <Text>Enter valid camera IPv4 address</Text>)
          }
        }
    }

    async function analyzeCamera() {
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

    function applyStreamSourceFromAnalysis() {
        if (!analysisResult || !analysisResult.media_profiles) return;
        const prof = analysisResult.media_profiles.find(p => p.rtsp_url);
        if (prof && prof.rtsp_url) {
            updatePanelValues('streamSource', prof.rtsp_url);
        }
    }

    function savePanel(event, ctx) {
        const {key} =  ctx && typeof ctx === 'object' ? ctx : {}

        setError(null)
        setPanel(prev => ({...prev, loading: true}))
        fetch(`/api/${panel.key === 'settings' ? 'settings' : `camera/${panel.values.key || 'new'}`}${key && panel.values.key ? `?delopt=${key}` : ''}`, {
        method: 'POST',
        credentials: 'same-origin',
        mode: 'cors',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(panel.values)
        }).then(res => {
        if (res.ok) {
            console.log(`created success : ${JSON.stringify(res)}`)
            getServerData()
            setPanel({open: false, invalidArray: [], loading: false})
        } else {
            return res.text().then(text => {throw new Error(text)})
            //const ferr = `created failed : ${succ.status} ${succ.statusText}`
            //console.error(ferr)
            //setError(ferr)
        }
        
        }).catch(error => {
        console.error(`created failed : ${error}`)
        setError(`created failed : ${error}`)
        setPanel(prev => ({...prev, loading: false}))
        })
    }

    const currCamera = panel.key === 'edit' && data.cameras && panel.values.key && data.cameras.find(c => c.key === panel.values.key)
    return panel.open ? (
      <>

      <Dialog modalType='modal' open={panel.open}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{panel.heading}</DialogTitle>
            
            { panel.key === 'settings' ? 
              <DialogContent className={styles.base}>

                    <Divider ><b>Storage Settings</b></Divider>

                    <Field
                      label="Disk Mount Folder"
                      validationState={getError('disk_base_dir') ? "error" : "none"}
                      validationMessage={getError('disk_base_dir')}>
                      <Input style={{"width": "100%"}} contentBefore={<Folder16Regular/>} required value={panel.values.disk_base_dir} onChange={(_, data) => updatePanelValues('disk_base_dir', data.value)}  />
                    </Field>

                    <div className={styles.root}>
                      <label>Check Capacity Interval {panel.values.disk_cleanup_interval} minutes</label>
                      <Slider style={{"width": "100%"}} min={0} max={60} step={5} defaultValue={panel.values.disk_cleanup_interval} showValue onChange={(_,data) => updatePanelValues('disk_cleanup_interval', data.value)} />
                    </div>

                    <div className={styles.root}>
                      <label>Keep under Capacity {panel.values.disk_cleanup_capacity}%</label>
                      <Slider style={{"width": "100%"}} disabled={panel.values.disk_cleanup_interval === 0}  min={20} max={100} step={5} defaultValue={panel.values.disk_cleanup_capacity} showValue onChange={(_,data) => updatePanelValues('disk_cleanup_capacity', data.value)} />
                    </div>


                    <Divider><b>Object Detection</b></Divider>
                    
                    <Checkbox label="Enable Object Detection" checked={panel.values.detection_enable} onChange={(_,data) => updatePanelValues('detection_enable', data.checked)} />
                    
                    <Field
                      label="YOLO Model Path"
                      hint="Relative to ./ai directory (e.g., 'model/yolo11n.onnx' or 'model/yolo11n-rk3588.rknn')"
                      validationState={getError('detection_model') ? "error" : "none"}
                      validationMessage={getError('detection_model')}>
                      <Input 
                        style={{"width": "100%"}} 
                        disabled={!panel.values.detection_enable}
                        placeholder="model/yolo11n.onnx"
                        value={panel.values.detection_model || ''} 
                        onChange={(_, data) => updatePanelValues('detection_model', data.value)} />
                    </Field>

                    <Field
                      label="Target Platform"
                      hint="Hardware acceleration target (leave empty for CPU/ONNX)"
                      validationState={getError('detection_target_hw') ? "error" : "none"}
                      validationMessage={getError('detection_target_hw')}>  
                      <Dropdown 
                        style={{"width": "100%"}} 
                        disabled={!panel.values.detection_enable}
                        placeholder="CPU (default)"
                        value={panel.values.detection_target_hw || ''}
                        selectedOptions={panel.values.detection_target_hw ? [panel.values.detection_target_hw] : []}
                        onOptionSelect={(_, data) => updatePanelValues('detection_target_hw', data.optionValue)}>
                        <Option key="" value="">CPU (default)</Option>
                        <Option key="rk3588" value="rk3588">RK3588 (RKNN)</Option>
                        <Option key="rk3576" value="rk3576">RK3576 (RKNN)</Option>
                      </Dropdown>
                    </Field>

                    <Field
                      label="Frames Output Path"
                      hint="Relative to Base Directory above (e.g., 'frames' or 'ml_images')"
                      validationState={getError('detection_frames_path') ? "error" : "none"}
                      validationMessage={getError('detection_frames_path')}>
                      <Input 
                        style={{"width": "100%"}} 
                        disabled={!panel.values.detection_enable} 
                        contentBefore={<Folder16Regular/>}  
                        placeholder="frames"
                        value={panel.values.detection_frames_path || ''} 
                        onChange={(_, data) => updatePanelValues('detection_frames_path', data.value)} />
                    </Field>

                    <Divider><b>Tag Filters (Filtered Mode)</b></Divider>
                    
                    <Field
                      label="Minimum Probability Filters"
                      hint="Only show tags that meet or exceed their minimum probability threshold">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' }}>
                        {(panel.values.detection_tag_filters || []).map((filter, idx) => (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px', border: '1px solid #e0e0e0', borderRadius: '4px' }}>
                            <Badge appearance="outline" style={{ minWidth: '80px' }}>{filter.tag}</Badge>
                            <div style={{ flex: 1 }}>
                              <Slider 
                                min={0} 
                                max={1} 
                                step={0.05} 
                                value={filter.minProbability}
                                disabled={!panel.values.detection_enable}
                                onChange={(_, data) => {
                                  const newFilters = [...panel.values.detection_tag_filters];
                                  newFilters[idx] = { ...filter, minProbability: data.value };
                                  updatePanelValues('detection_tag_filters', newFilters);
                                }} />
                            </div>
                            <Text style={{ minWidth: '45px', textAlign: 'right' }}>
                              ≥{Math.round(filter.minProbability * 100)}%
                            </Text>
                            <Button 
                              size="small" 
                              appearance="subtle"
                              disabled={!panel.values.detection_enable}
                              onClick={() => {
                                const newFilters = panel.values.detection_tag_filters.filter((_, i) => i !== idx);
                                updatePanelValues('detection_tag_filters', newFilters);
                              }}>
                              Remove
                            </Button>
                          </div>
                        ))}
                        {(!panel.values.detection_tag_filters || panel.values.detection_tag_filters.length === 0) && (
                          <Text style={{ fontStyle: 'italic', color: '#666' }}>
                            No filters configured. Add a tag below or right-click any badge in the movement list.
                          </Text>
                        )}
                        <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                          <Input 
                            style={{ flex: 1 }}
                            placeholder="Enter tag name (e.g., person, car, toilet)"
                            disabled={!panel.values.detection_enable}
                            id="newTagFilterInput"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                const input = e.target;
                                const tagName = input.value.trim().toLowerCase();
                                if (tagName) {
                                  const currentFilters = panel.values.detection_tag_filters || [];
                                  if (!currentFilters.find(f => f.tag === tagName)) {
                                    const newFilters = [...currentFilters, { tag: tagName, minProbability: 0.5 }];
                                    updatePanelValues('detection_tag_filters', newFilters);
                                    input.value = '';
                                  }
                                }
                              }
                            }}
                          />
                          <Button 
                            disabled={!panel.values.detection_enable}
                            onClick={() => {
                              const input = document.getElementById('newTagFilterInput');
                              const tagName = input?.value?.trim().toLowerCase();
                              if (tagName) {
                                const currentFilters = panel.values.detection_tag_filters || [];
                                if (!currentFilters.find(f => f.tag === tagName)) {
                                  const newFilters = [...currentFilters, { tag: tagName, minProbability: 0.5 }];
                                  updatePanelValues('detection_tag_filters', newFilters);
                                  input.value = '';
                                }
                              }
                            }}>
                            Add Filter
                          </Button>
                        </div>
                      </div>
                    </Field>

                    <Divider><b>Advanced Settings</b></Divider>
                    
                    <div className={styles.root}>
                      <label>Shutdown Timeout: {panel.values.shutdown_timeout_ms !== undefined ? panel.values.shutdown_timeout_ms : 5000}ms</label>
                      <Slider 
                        style={{"width": "100%"}} 
                        min={1000} 
                        max={30000} 
                        step={1000} 
                        defaultValue={panel.values.shutdown_timeout_ms !== undefined ? panel.values.shutdown_timeout_ms : 5000}  
                        onChange={(_,data) => updatePanelValues('shutdown_timeout_ms', data.value)} />
                    </div>

                    <div className={styles.root}>
                      <label>Stream Verify Timeout: {panel.values.stream_verify_timeout_ms !== undefined ? panel.values.stream_verify_timeout_ms : 10000}ms</label>
                      <Slider 
                        style={{"width": "100%"}} 
                        min={2000} 
                        max={60000} 
                        step={1000} 
                        defaultValue={panel.values.stream_verify_timeout_ms !== undefined ? panel.values.stream_verify_timeout_ms : 10000}  
                        onChange={(_,data) => updatePanelValues('stream_verify_timeout_ms', data.value)} />
                    </div>

                    <Divider><b>Disk Status</b></Divider>
                    
                    {diskStatusLoading ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px' }}>
                        <Spinner size="tiny" />
                        <Text>Loading disk status...</Text>
                      </div>
                    ) : diskStatus && !diskStatus.error ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                          <div>
                            <Text size={200} style={{ color: '#666' }}>Last Cleanup</Text>
                            <Text block weight="semibold">{diskStatus.lastRunAt_en_GB || 'Never'}</Text>
                          </div>
                          <div>
                            <Text size={200} style={{ color: '#666' }}>Total Movements</Text>
                            <Text block weight="semibold">{diskStatus.totalMovementsRemaining?.toLocaleString() || '0'}</Text>
                          </div>
                        </div>
                        
                        {diskStatus.perCamera && diskStatus.perCamera.length > 0 ? (
                          <div style={{ border: '1px solid #e0e0e0', borderRadius: '4px', overflow: 'hidden' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                              <thead>
                                <tr style={{ background: '#f5f5f5' }}>
                                  <th style={{ padding: '8px', textAlign: 'left', borderBottom: '1px solid #e0e0e0' }}>Camera</th>
                                  <th style={{ padding: '8px', textAlign: 'right', borderBottom: '1px solid #e0e0e0' }}>Files Deleted</th>
                                  <th style={{ padding: '8px', textAlign: 'right', borderBottom: '1px solid #e0e0e0' }}>Movements Deleted</th>
                                  <th style={{ padding: '8px', textAlign: 'right', borderBottom: '1px solid #e0e0e0' }}>Remaining</th>
                                  <th style={{ padding: '8px', textAlign: 'left', borderBottom: '1px solid #e0e0e0' }}>Cutoff Date</th>
                                </tr>
                              </thead>
                              <tbody>
                                {diskStatus.perCamera.map((cam, idx) => (
                                  <tr key={cam.cameraKey} style={{ background: idx % 2 === 0 ? '#fff' : '#fafafa' }}>
                                    <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>{cam.cameraName}</td>
                                    <td style={{ padding: '8px', textAlign: 'right', borderBottom: '1px solid #eee' }}>{cam.filesDeleted?.toLocaleString() || '0'}</td>
                                    <td style={{ padding: '8px', textAlign: 'right', borderBottom: '1px solid #eee' }}>{cam.movementsDeleted?.toLocaleString() || '0'}</td>
                                    <td style={{ padding: '8px', textAlign: 'right', borderBottom: '1px solid #eee' }}>{cam.movementsRemaining?.toLocaleString() || '0'}</td>
                                    <td style={{ padding: '8px', borderBottom: '1px solid #eee' }}>{cam.cutoffDate_en_GB || 'N/A'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <Text style={{ fontStyle: 'italic', color: '#666' }}>
                            No disk cleanup has run yet. Status will appear after the first cleanup cycle.
                          </Text>
                        )}
                      </div>
                    ) : (
                      <Text style={{ fontStyle: 'italic', color: '#666' }}>
                        {diskStatus?.error || 'No disk status available. Enable disk cleanup to see statistics.'}
                      </Text>
                    )}

                    <div className={styles.root}></div>

              </DialogContent>
            :
              <DialogContent className={styles.base}>
                    
                    <Field
                      label="Camera Name"
                      validationState={getError('name') ? "error" : "none"}
                      validationMessage={getError('name')}>
                      <Input style={{"width": "100%"}} contentBefore={<Camera16Regular/>}  required value={panel.values.name} onChange={(_, data) => updatePanelValues('name', data.value)} />
                    </Field>

                    <Field
                      label="IP Address (display on create only)"
                      validationState={getError('ip') ? "error" : "none"}
                      validationMessage={getError('ip')}>
                      <Input style={{"width": "100%"}} contentBefore={<NetworkAdapter16Regular/>}  required value={panel.values.ip} onChange={(_, data) => updatePanelValues('ip', data.value)} />
                    </Field>

                    <Field
                      label="Camera Password"
                      hint={panel.values.passwd === '<set>' ? 'A password is set. Re-enter to change, or leave blank to keep the existing one.' : 'Display only on create.'}
                      validationState={getError('passwd') ? "error" : "none"}
                      validationMessage={getError('passwd')}>
                      <Input style={{"width": "100%"}} contentBefore={<Password16Regular/>}  required={panel.values.passwd !== '<set>'} type="password" placeholder={panel.values.passwd === '<set>' ? '(set — leave blank to keep)' : ''} value={panel.values.passwd === '<set>' ? '' : (panel.values.passwd || '')} onChange={(_, data) => updatePanelValues('passwd', data.value)} />
                    </Field>

                    <Divider><b>Advanced Stream Settings</b></Divider>
                    
                    <Field
                      label="Stream Source (optional)"
                      hint="Override RTSP URL (e.g., 'rtsp://user:pass@ip:554/path' or '/path/to/video.mp4')">
                      <Input 
                        style={{"width": "100%"}} 
                        placeholder="Leave empty to use IP/Password"
                        value={panel.values.streamSource || ''} 
                        onChange={(_, data) => updatePanelValues('streamSource', data.value)} />
                    </Field>

                    <Field
                      label="Motion Detection URL (optional)"
                      hint="Override motion API URL (e.g., 'http://ip/api/motion')">
                      <Input 
                        style={{"width": "100%"}} 
                        placeholder="Leave empty to use IP/Password"
                        value={panel.values.motionUrl || ''} 
                        onChange={(_, data) => updatePanelValues('motionUrl', data.value)} />
                    </Field>

                    <Divider><b>Video Files</b></Divider>
                    
                    <Field
                      label="Storage Location"
                      validationState={getError('disk') || getError('folder') ? "error" : "none"}
                      validationMessage={getError('disk') || getError('folder')}>
                      <div>
                          <div  style={{"display": "inline-block"}} >
                          <Select style={{ "maxWidth": "150px"}} value={panel.values.disk}  required onChange={(_, data) => updatePanelValues('disk', data.value)} >
                            {data.config &&  <option>{data.config.settings.disk_base_dir}</option>  }
                          </Select>
                          </div>
                          /
                          <div  style={{"display": "inline-block"}} >
                            <Input contentAfter={<Folder16Regular/>}  required value={panel.values.folder} onChange={(_, data) => updatePanelValues('folder', data.value)} />
                          </div>
                      </div>
                    </Field>

                    
                    <Divider><b>Playback</b></Divider>

                    <Checkbox label="Enable Streaming" checked={panel.values.enable_streaming} onChange={(_,data) => { updatePanelValues('enable_streaming', data.checked)} } />

                    <div className={styles.root}>
                      <label>Playback seconds prior to movement: {panel.values.segments_prior_to_movement*2} seconds</label>
                      <Slider style={{"width": "100%"}} disabled={!panel.values.enable_streaming}  min={0} max={60} step={1} defaultValue={panel.values.segments_prior_to_movement}  onChange={(_,data) => updatePanelValues('segments_prior_to_movement', data.value)} />
                    </div>
                    
                    <div className={styles.root}>
                      <label>Playback seconds post movement: {panel.values.segments_post_movement*2} seconds</label>
                      <Slider style={{"width": "100%"}} disabled={!panel.values.enable_streaming}  min={0} max={60} step={1} defaultValue={panel.values.segments_post_movement}  onChange={(_,data) => updatePanelValues('segments_post_movement', data.value)} />
                    </div>

                    <Divider><b>Global AI Detection Defaults</b></Divider>
                    <Text size={200} style={{color: '#666'}}>
                        Which YOLO classes to keep in detection output. Applies to all cameras
                        that don't have their own override below. Changes take effect on the
                        next movement.
                    </Text>
                    {globalClasses && (
                      <div style={{display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '4px 12px', marginTop: '4px'}}>
                        {INDIVIDUAL_CLASSES.map(c => (
                          <Checkbox
                            key={c.id}
                            label={c.label}
                            checked={globalClasses.individual.includes(c.id)}
                            onChange={() => { toggleIndividual(setGlobalClasses, globalClasses, c.id); setGlobalClassesDirty(true); }}
                          />
                        ))}
                        <Checkbox
                          label={'其他 (animals, electronics, furniture, ...)'}
                          checked={globalClasses.others}
                          onChange={() => { toggleOthers(setGlobalClasses, globalClasses); setGlobalClassesDirty(true); }}
                        />
                      </div>
                    )}
                    <div style={{display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px'}}>
                      <Button
                        appearance="primary"
                        disabled={!globalClassesDirty || globalClassesSaving}
                        onClick={saveGlobalClasses}
                      >
                        {globalClassesSaving ? 'Saving...' : 'Save Global Defaults'}
                      </Button>
                      {globalClassesDirty && <Text size={200} style={{color: '#666'}}>unsaved</Text>}
                    </div>

                    <Divider><b>AI Analysis</b></Divider>

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

                    <Divider><b>Camera AI Classes</b></Divider>
                    <Text size={200} style={{color: '#666'}}>
                        Override the global class filter for this camera. Uncheck "Use Global"
                        to enable a per-camera list.
                    </Text>
                    <Checkbox
                      label="Use Global Default"
                      checked={cameraClasses === null}
                      onChange={(_, data) => {
                          if (data.checked) {
                              setCameraClasses(null);
                          } else {
                              // Seed with the resolved global so user has a starting point
                              const g = data?.config?.settings?.aiEnabledClasses
                                  || globalClasses
                                  || { individual: [0,1,2,3,4,5,6,7,8], others: true };
                              setCameraClasses({ individual: g.individual || [], others: !!g.others });
                          }
                      }}
                    />
                    {cameraClasses !== null && (
                      <div style={{display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '4px 12px', marginTop: '4px'}}>
                        {INDIVIDUAL_CLASSES.map(c => (
                          <Checkbox
                            key={c.id}
                            label={c.label}
                            checked={cameraClasses.individual.includes(c.id)}
                            onChange={() => setCameraClasses(prev => {
                                const ind = prev?.individual || [];
                                return { ...(prev || { individual: [], others: true }),
                                         individual: ind.includes(c.id) ? ind.filter(x => x !== c.id) : [...ind, c.id] };
                            })}
                          />
                        ))}
                        <Checkbox
                          label={'其他 (animals, electronics, furniture, ...)'}
                          checked={cameraClasses.others}
                          onChange={() => setCameraClasses(prev => ({
                              ...(prev || { individual: [], others: true }),
                              others: !prev?.others,
                          }))}
                        />
                      </div>
                    )}
                    <Button
                      appearance="subtle"
                      disabled={!panel.values.key}
                      onClick={saveCameraClasses}
                    >
                      Save Camera Override
                    </Button>

                    <Divider><b>Movement processing</b></Divider>
                    
                    <Checkbox disabled={!panel.values.enable_streaming} label="Enable Movement" checked={panel.values.enable_movement} onChange={(_, data) => updatePanelValues('enable_movement', data.checked)} />
                    
                    <div className={styles.root}>
                      <label>Poll Frequency: {panel.values.mSPollFrequency/1000} seconds</label>
                      <Slider style={{"width": "100%"}} disabled={!panel.values.enable_movement} min={1000} max={10000} step={500} defaultValue={panel.values.mSPollFrequency}  onChange={(_,data) => updatePanelValues('mSPollFrequency', data.value)} />
                    </div>

                    <div className={styles.root}>
                      <label>Extend capturing movement after camera reports no movement for {panel.values.pollsWithoutMovement} poll(s) (0 = stop immediately)</label>
                      <Slider style={{"width": "100%"}} disabled={!panel.values.enable_movement}  min={0} max={10} step={1} defaultValue={panel.values.pollsWithoutMovement}  onChange={(_,data) => updatePanelValues('pollsWithoutMovement', data.value)} />
                      {panel.values.pollsWithoutMovement === 0 && (
                        <Alert intent="warning" style={{marginTop: "4px"}}>
                          Setting to 0 may cause frame extraction to fail for short movements. Use at least 1-2 polls for reliable detection.
                        </Alert>
                      )}
                    </div>
                    
                    <div className={styles.root}>
                      <label>Max. Single Movement {panel.values.secMaxSingleMovement} seconds</label>
                      <Slider style={{"width": "100%"}} disabled={!panel.values.enable_movement}  min={30} max={90} step={10} defaultValue={panel.values.secMaxSingleMovement}  onChange={(_,data) => updatePanelValues('secMaxSingleMovement', data.value)} />
                    </div>
                    
                    <div className={styles.root}>
                      <label>Startup Delay {panel.values.secMovementStartupDelay !== undefined ? panel.values.secMovementStartupDelay : 10} seconds (wait after stream starts before checking for movement)</label>
                      <Slider style={{"width": "100%"}} disabled={!panel.values.enable_movement}  min={0} max={60} step={5} defaultValue={panel.values.secMovementStartupDelay !== undefined ? panel.values.secMovementStartupDelay : 10}  onChange={(_,data) => updatePanelValues('secMovementStartupDelay', data.value)} />
                    </div>

              </DialogContent>
            }

            <DialogActions>

              { panel.loading && 
                <div style={{display: 'flex', alignItems: 'center', gap: '8px', marginRight: 'auto'}}>
                  <Spinner size="small" />
                  <Text>Please wait...</Text>
                </div>
              }

              { panel.key === 'edit' &&
                      
                 <MySplitButton  label="Delete" disabled={panel.invalidArray.length >0 || panel.loading}  items={[
                        {
                            key: 'reset',
                            text: 'Reset Recordings (keep camera)',
                            iconProps: { iconName: 'Refresh' },
                            onClick: savePanel
                        },
                        {
                            key: 'del',
                            text: 'Delete Camera',
                            iconProps: { iconName: 'Delete' },
                            onClick: savePanel
                        },
                        {
                            key: 'delall',
                            text: 'Delete Camera & Recordings',
                            iconProps: { iconName: 'Delete' },
                            onClick: savePanel
                   }]} />
                   
                }
              <Button appearance="primary" disabled={panel.invalidArray.length >0 || panel.loading} onClick={savePanel}>Save</Button>
              <DialogTrigger disableButtonEnhancement >
                <Button appearance="secondary" disabled={panel.loading} onClick={() => setPanel({...panel, open: false, invalidArray: []})} >Close</Button>
              </DialogTrigger>

              {error &&
                <Alert intent='error' >
                {error}
                </Alert>
              }
            </DialogActions>
          </DialogBody>
        </DialogSurface>

      </Dialog>

      {analysisOpen ? (
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
                {analysisResult && !analyzing && (
                  <>
                    <Field label='Reachable'><Text>{String(analysisResult.reachable)}</Text></Field>
                    <Field label='ONVIF Supported'><Text>{String(analysisResult.onvif_supported)}</Text></Field>
                    <Field label='Motion Event Support'><Text>{String(analysisResult.motion_event_support)}</Text></Field>
                    {analysisResult.device_info && (
                      <Field label='Device Info'>
                        <Text>
                          Mfr: {analysisResult.device_info.manufacturer || '?'}<br/>
                          Model: {analysisResult.device_info.model || '?'}<br/>
                          Firmware: {analysisResult.device_info.firmwareVersion || '?'}<br/>
                          Serial: {analysisResult.device_info.serialNumber || '?'}
                        </Text>
                      </Field>
                    )}
                    {analysisResult.media_profiles && analysisResult.media_profiles.length > 0 && (
                      <Field label='Media Profiles (RTSP URLs)'>
                        {analysisResult.media_profiles.map((p, i) => (
                          <div key={i} style={{padding: '4px 0'}}>
                            <Badge appearance='outline'>{p.name || p.token}</Badge>
                            <Text size={100} style={{wordBreak: 'break-all'}}>{p.rtsp_url || '(no RTSP)'}</Text>
                          </div>
                        ))}
                      </Field>
                    )}
                    {analysisResult.errors && analysisResult.errors.length > 0 && (
                      <Field label='Errors'>
                        {analysisResult.errors.map((e, i) => <Text key={i} style={{color: 'red'}}>{e}</Text>)}
                      </Field>
                    )}
                  </>
                )}
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setAnalysisOpen(false)} appearance='subtle'>Close</Button>
                {analysisResult && analysisResult.media_profiles?.some(p => p.rtsp_url) && (
                  <Button onClick={() => { applyStreamSourceFromAnalysis(); setAnalysisOpen(false); }} appearance='primary'>
                    Apply RTSP to Stream Source
                  </Button>
                )}
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      ) : null}
      </>
    ) : null;
}