/**
 * Live Detection Server
 * Lightweight REST server for single-frame object detection.
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 9999;
const DETECTOR_MODEL = './yolo11n.onnx';
const DETECTOR_CWD = '/home/ya-001/open-source-nvr/ai';
const FRAME_TTL_MS = 5000;

let detectorProc = null;
let pendingCallbacks = new Map();
const tempDir = os.tmpdir();

setInterval(() => {
    const now = Date.now();
    try {
        const files = fs.readdirSync(tempDir).filter(f => f.startsWith('live_frame_'));
        for (const file of files) {
            const filePath = path.join(tempDir, file);
            try {
                const stat = fs.statSync(filePath);
                if (now - stat.mtimeMs > FRAME_TTL_MS) {
                    fs.unlinkSync(filePath);
                }
            } catch {}
        }
    } catch {}
}, 10000);

function initDetector() {
    if (detectorProc) return;
    detectorProc = spawn('python3', ['-u', '-m', 'detector.detect', '--model_path', DETECTOR_MODEL], {
        cwd: DETECTOR_CWD,
        stdio: ['pipe', 'pipe', 'pipe']
    });

    detectorProc.stdout.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const result = JSON.parse(line);
                if (result.image && result.detections) {
                    const match = result.image.match(/live_frame_(.+)\.jpg/);
                    if (match && pendingCallbacks.has(match[1])) {
                        const cb = pendingCallbacks.get(match[1]);
                        pendingCallbacks.delete(match[1]);
                        cb({
                            bboxes: result.detections.map(d => ({
                                object: d.object,
                                box: d.box,
                                probability: d.probability
                            })),
                            frameId: match[1]
                        });
                    }
                }
            } catch {}
        }
    });

    detectorProc.on('close', () => { detectorProc = null; });
    console.log('Live detector: python process started');
}

function sendToDetector(framePath, frameId) {
    return new Promise((resolve) => {
        pendingCallbacks.set(frameId, resolve);
        if (detectorProc && detectorProc.stdin) {
            detectorProc.stdin.write(framePath + '\n');
        }
        setTimeout(() => {
            if (pendingCallbacks.has(frameId)) {
                pendingCallbacks.delete(frameId);
                resolve({ bboxes: [], frameId });
            }
        }, 4000);
    });
}

async function handleDetect(req, res) {
    if (!req.cameraKey || !req.image) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'cameraKey and image required' }));
        return;
    }

    if (!detectorProc || detectorProc.exitCode !== null) {
        initDetector();
        await new Promise(r => setTimeout(r, 1500));
    }

    const frameId = Date.now() + '_' + Math.random().toString(36).substring(7);
    const framePath = path.join(tempDir, 'live_frame_' + frameId + '.jpg');

    try {
        const imageData = req.image.replace(/^data:image\/\w+;base64,/, '');
        const imageBuffer = Buffer.from(imageData, 'base64');
        fs.writeFileSync(framePath, imageBuffer);
        const result = await sendToDetector(framePath, frameId);
        result.cameraKey = req.cameraKey;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Detection failed' }));
    } finally {
        try { fs.unlinkSync(framePath); } catch {}
    }
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200); res.end(); return;
    }
    if (req.method === 'POST' && req.url === '/detect') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                handleDetect(JSON.parse(body), res);
            } catch {
                res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200); res.end(JSON.stringify({ status: 'ok', detectorReady: !!detectorProc })); return;
    }
    res.writeHead(404); res.end();
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('Live detector listening on http://127.0.0.1:' + PORT + '/detect');
});

server.on('error', (err) => {
    console.error('Live detector server error:', err);
});
