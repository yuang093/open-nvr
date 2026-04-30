# Prometheus Metrics

The NVR server exposes Prometheus metrics at **`GET /metrics`** on the same port as the web UI (default `8080`).

## Available Metrics

### Movement Detection (per camera)
| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `nvr_movement_detection_api_calls_total` | counter | camera, result | Camera motion API poll calls (result: detected/none/error) |
| `nvr_movements_created_total` | counter | camera | New movements detected |
| `nvr_movement_duration_seconds` | histogram | camera | Video duration of finalized movements |

### Object Detection Pipeline (per camera)
| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `nvr_movement_processing_duration_seconds` | histogram | camera | Total time from processing start to completion |
| `nvr_movement_processing_result_total` | counter | camera, result | Processing outcomes (completed/failed/timeout) |
| `nvr_movement_frames_sent_total` | counter | camera | Frames sent to ML detector |
| `nvr_movement_frames_received_total` | counter | camera | ML results received |
| `nvr_ml_frame_processing_duration_seconds` | histogram | camera | Per-frame ML inference latency |
| `nvr_movement_detection_to_processing_lag_seconds` | histogram | camera | Lag between movement detection and ML processing start |
| `nvr_ml_objects_detected_total` | counter | camera, object_class | Objects detected by class (person, car, etc.) |

### ML Detector Health
| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `nvr_ml_detector_running` | gauge | — | 1 if ML detector process is alive |
| `nvr_ml_detector_frames_in_flight` | gauge | — | Frames awaiting ML results |
| `nvr_ml_detector_restarts_total` | counter | reason | Process restarts (scheduled/crash/disabled) |

### Disk Cleanup (per camera)
| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `nvr_disk_cleanup_files_deleted_total` | counter | camera | Video files deleted |
| `nvr_disk_cleanup_bytes_deleted_total` | counter | camera | Bytes reclaimed |
| `nvr_disk_cleanup_movements_deleted_total` | counter | camera | Movement records pruned from DB |
| `nvr_disk_cleanup_runs_total` | counter | — | Cleanup runs executed |

### System
| Metric | Type | Description |
|--------|------|-------------|
| `nvr_control_loop_duration_seconds` | histogram | Control loop iteration time |
| `nvr_active_cameras` | gauge | Cameras with streaming enabled |

Node.js default metrics (GC, event loop, memory, CPU) are also included automatically.

### Key Queries for "Is object detection falling behind?"

```promql
# Lag between movement detection and ML processing start (p95)
histogram_quantile(0.95, rate(nvr_movement_detection_to_processing_lag_seconds_bucket[5m]))

# Frames in flight (sustained high = detector can't keep up)
nvr_ml_detector_frames_in_flight

# Frame drop rate (sent vs received)
rate(nvr_movement_frames_sent_total[5m]) - rate(nvr_movement_frames_received_total[5m])

# Per-frame ML latency (p95)
histogram_quantile(0.95, rate(nvr_ml_frame_processing_duration_seconds_bucket[5m]))
```

---

## Local Prometheus Agent Setup

The recommended setup is a local Prometheus agent that scrapes the NVR `/metrics` endpoint and remote-writes to Azure Monitor managed Prometheus.

### 1. Install Prometheus

Download the Prometheus binary matching your architecture (`amd64`, `arm64`, etc.):

```bash
# Example for arm64 (e.g. Rock 5B, Raspberry Pi 4/5)
ARCH=arm64
VERSION=2.53.0

wget https://github.com/prometheus/prometheus/releases/download/v${VERSION}/prometheus-${VERSION}.linux-${ARCH}.tar.gz
tar xzf prometheus-${VERSION}.linux-${ARCH}.tar.gz
sudo mv prometheus-${VERSION}.linux-${ARCH}/prometheus /usr/local/bin/
sudo mv prometheus-${VERSION}.linux-${ARCH}/promtool /usr/local/bin/
rm -rf prometheus-${VERSION}.linux-${ARCH}*
```

### 2. Create Azure Monitor Workspace

```bash
# Create an Azure Monitor workspace (hosts managed Prometheus)
az monitor account create \
  --name nvr-monitor \
  --resource-group <your-rg> \
  --location <your-location>
```

From the output, note:
- The **metrics ingestion endpoint** — find it in the Azure portal under your Azure Monitor workspace → Overview → "Metrics ingestion endpoint", or query the Data Collection Endpoint:
  ```bash
  az monitor data-collection endpoint show \
    --name nvr-monitor \
    --resource-group MA_nvr-monitor_<location>_managed \
    --query metricsIngestion.endpoint -o tsv
  ```
- The **Data Collection Rule (DCR) immutable ID** — find it in the portal or query:
  ```bash
  az monitor data-collection rule list \
    --query "[?contains(name,'nvr-monitor')].{name:name, immutableId:immutableId, resourceGroup:resourceGroup}" \
    -o table
  ```

The full remote write URL combines these:
```
https://<metrics-ingestion-endpoint>/dataCollectionRules/<dcr-immutable-id>/streams/Microsoft-PrometheusMetrics/api/v1/write?api-version=2023-04-24
```

> **Note:** Azure Monitor creates a managed resource group (e.g. `MA_nvr-monitor_<location>_managed`) containing the DCR and DCE. You'll need this resource group name for role assignments below.

### 3. Create Entra ID App Registration

```bash
# Create an Entra ID app registration for authentication
az ad app create --display-name nvr-prometheus-writer --query appId -o tsv
# Note the appId from the output

# Create a service principal
az ad sp create --id <app-id>

# Create a client secret
az ad app credential reset --id <app-id> --append
# Note the appId, password (client secret), and tenant from the output
```

### 4. Assign Permissions

The service principal needs the **"Monitoring Metrics Publisher"** role on the **Data Collection Rule (DCR)** in the managed resource group. Assigning the role on the Azure Monitor workspace alone is not sufficient.

```bash
# Find the DCR resource ID
DCR_ID=$(az monitor data-collection rule list \
  --query "[?contains(name,'nvr-monitor')].id" -o tsv)

# Assign "Monitoring Metrics Publisher" role on the DCR
az role assignment create \
  --assignee <app-id> \
  --role "Monitoring Metrics Publisher" \
  --scope $DCR_ID
```

> **Important:** Azure RBAC role assignments can take up to 5–10 minutes to propagate. If you see 403 errors immediately after assigning the role, wait and retry.

> **Alternative: Managed Identity** — If running on an Azure VM, assign the VM's managed identity the "Monitoring Metrics Publisher" role on the DCR instead of using client secrets. Use only the `managed_identity` section in the Prometheus config below.

### 5. Configure Prometheus

Create `/etc/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'nvr'
    static_configs:
      - targets: ['localhost:8080']

remote_write:
  - url: 'https://<metrics-ingestion-endpoint>/dataCollectionRules/<dcr-immutable-id>/streams/Microsoft-PrometheusMetrics/api/v1/write?api-version=2023-04-24'
    azuread:
      cloud: 'AzurePublic'
      oauth:
        client_id: '<app-id>'
        client_secret: '<client-secret>'
        tenant_id: '<tenant-id>'
```

Protect the config file since it contains credentials:

```bash
sudo chmod 600 /etc/prometheus/prometheus.yml
sudo chown prometheus:prometheus /etc/prometheus/prometheus.yml
```

### 6. Run Prometheus as a systemd service

Create `/etc/systemd/system/prometheus.service`:

```ini
[Unit]
Description=Prometheus Agent
After=network.target

[Service]
Type=simple
User=prometheus
ExecStart=/usr/local/bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.agent.path=/var/lib/prometheus/agent \
  --web.listen-address=:9090 \
  --enable-feature=agent
Restart=always

[Install]
WantedBy=multi-user.target
```

> The `--enable-feature=agent` flag runs Prometheus in agent mode — it only scrapes and remote-writes, with no local TSDB storage. Do not use `--storage.tsdb.*` flags in agent mode; use `--storage.agent.path` for the WAL directory.

```bash
sudo useradd --no-create-home --shell /bin/false prometheus
sudo mkdir -p /etc/prometheus /var/lib/prometheus
sudo chown prometheus:prometheus /var/lib/prometheus
sudo systemctl daemon-reload
sudo systemctl enable --now prometheus
```

### 7. Verify

```bash
# Check the service is running
sudo systemctl status prometheus

# Check for errors in the logs (no output = healthy)
journalctl -u prometheus --no-pager --since "1 min ago" | grep -i error

# Check NVR metrics are being exposed
curl -s http://localhost:8080/metrics | head -20
```

### 8. Visualize with Azure Managed Grafana

1. Create an Azure Managed Grafana instance in the Azure portal
2. Link it to your Azure Monitor workspace (done automatically if in the same resource group)
3. The managed Prometheus data source is auto-configured
4. Import dashboards or query metrics using the PromQL examples above
