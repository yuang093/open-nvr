/**
 * Live Detection Server
 * Lightweight REST server for single-frame object detection.
 * Runs independently from the main NVR pipeline (movement-triggered).
 *
 * Provides real-time bbox overlay for live camera streams.
 */

import http from 'http';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = 9999;
const DETECTOR_MODEL = './yolo11n.onnx';
const DETECTOR_CWD = '/home/ya-001/open-source-nvr/ai';
const FRAME_TTL_MS = 5000; // Auto-cleanup frames older than this

interface DetectionRequest {
    cameraKey: string;
    image: string; // base64 encoded
}

interface BBox {
    object: string;
    box: [number, number, number, number]; // [x1, y1, x2, y2] in 640x640 coords
    probability: number;
}

interface DetectionResult {
    cameraKey: string;
    bboxes: BBox[];
    frameId: string;
    timestamp: number;
}

// Active detector processes
let detectorProc: ChildProcessWithoutNullStreams | null = null;
let detectorReady = false;
let pendingCallbacks: Map<string, (result: DetectionResult) => void> = new Map();

// Cleanup old temp frames
const tempDir = os.tmpdir();
setInterval(() => {
    const now = Date.now();
    try {
        const files = fs.readdirSync(tempDir).filter(f => f.startsWith('live_frame_'));
        for (const file of files) {
            const filePath = path.join(tempDir, file);
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > FRAME_TTL_MS) {
                fs.unlinkSync(filePath);
            }
        }
    } catch {}
}, 10000);

function initDetector() {
    if (detectorProc) return;

    detectorProc = spawn('python3', ['-u', '-m', 'detector.detect', '--model_path', DETECTOR_MODEL], {
        cwd: DETECTOR_CWD,
        stdio: ['pipe', 'pipe', 'pipe']
    });

    detectorProc.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const result = JSON.parse(line);
                if (result.image && result.detections) {
                    // Extract frame ID from path like /tmp/live_frame_xxx.jpg
                    const match = result.image.match(/live_frame_(.+)\.jpg/);
                    if (match && pendingCallbacks.has(match[1])) {
                        const cb = pendingCallbacks.get(match[1])!;
                        pendingCallbacks.delete(match[1]);
                        cb({
                            cameraKey: '',
                            bboxes: result.detections.map((d: any) => ({
                                object: d.object,
                                box: d.box,
                                probability: d.probability
                            })),
                            frameId: match[1],
                            timestamp: Date.now()
                        });
                    }
                }
            } catch {}
        }
    });

    detectorProc.stderr?.on('data', (data: Buffer) => {
        // Log detector errors silently
    });

    detectorProc.on('close', () => {
        detectorProc = null;
        detectorReady = false;
    });
}

function sendToDetector(framePath: string, frameId: string): Promise<DetectionResult> {
    return new Promise((resolve) => {
        pendingCallbacks.set(frameId, resolve);
        detectorProc?.stdin?.write(`${framePath}\n`);
        // Timeout: auto-resolve with empty bboxes after 4s
        setTimeout(() => {
            if (pendingCallbacks.has(frameId)) {
                pendingCallbacks.delete(frameId);
                resolve({ cameraKey: '', bboxes: [], frameId, timestamp: Date.now() });
            }
        }, 4000);
    });
}

async function handleDetect(req: DetectionRequest, res: http.ServerResponse) {
    if (!req.cameraKey || !req.image) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'cameraKey and image required' }));
        return;
    }

    // Initialize detector if needed
    if (!detectorProc || detectorProc.exitCode !== null) {
        initDetector();
        // Wait for detector to start
        await new Promise(r => setTimeout(r, 1500));
    }

    const frameId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const framePath = path.join(tempDir, `live_frame_${frameId}.jpg`);

    try {
        // Decode base64 and save
        const imageBuffer = Buffer.from(req.image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        fs.writeFileSync(framePath, imageBuffer);

        const result = await sendToDetector(framePath, frameId);
        result.cameraKey = req.cameraKey;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
    } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Detection failed' }));
    } finally {
        // Cleanup frame file
        try { fs.unlinkSync(framePath); } catch {}
    }
}

const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.method === 'POST' && req.url === '/detect') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const reqData: DetectionRequest = JSON.parse(body);
                handleDetect(reqData, res);
            } catch {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok', detectorReady: !!detectorProc }));
        return;
    }

    res.writeHead(404);
    res.end();
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Live detector listening on http://127.0.0.1:${PORT}/detect`);
});

server.on('error', (err) => {
    console.error('Live detector server error:', err);
});
