/**
 * Web API routes and HTTP server configuration
 * Separated per required-server-program-structure.md
 */

import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import send from 'koa-send';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { Level } from 'level';
import type { Server } from 'node:http';
import http from 'node:http';
import { runProcess } from './process-utils.js';
import { sseManager, formatMovementForSSE } from './sse-manager.js';
import { diskCheck, catalogVideo, DiskCheckReturn } from './diskcheck.js';
import type { Logger } from 'winston';
import { registry } from './metrics.js';
import type { EnabledClasses } from './aiEnabledClasses.js';
import { defaultEnabledClasses, resolveEnabledClasses, enabledClassesToCsv } from './aiEnabledClasses.js';

// Types
export interface Settings {
    disk_base_dir: string;
    disk_cleanup_interval: number;
    disk_cleanup_capacity: number;
    detection_enable: boolean;
    detection_model: string;
    detection_target_hw: string;
    detection_frames_path: string;
    detection_tag_filters: TagFilter[];
    /**
     * Global default for which YOLO classes to keep in detection output.
     * Cameras can override via CameraEntry.enabledClasses.
     * null/undefined = use built-in default (all classes enabled).
     */
    aiEnabledClasses?: EnabledClasses | null;
    /** ML process restart schedule in cron-like format: "HH:MM" (24-hour). Empty = disabled. Default: "01:00" */
    ml_restart_schedule?: string;
    /** Timeout for graceful process shutdown in ms (default: 5000) */
    shutdown_timeout_ms?: number;
    /** Timeout for stream verification in ms (default: 10000) */
    stream_verify_timeout_ms?: number;
}

export interface TagFilter {
    tag: string;
    minProbability: number;
}

export interface MovementEntry {
    cameraKey: string;
    startDate: number;
    startSegment: number | null;
    lhs_seg_duration_seq?: number;
    seconds: number;
    pollCount: number;
    consecutivePollsWithoutMovement: number;
    detection_status?: string;
    detection_output?: DetectionOutput;
    processing_state?: 'pending' | 'processing' | 'completed' | 'failed';
    processing_started_at?: number;
    processing_completed_at?: number;
    processing_error?: string;
    processing_attempts?: number;
    endSegment?: number | null;
    playlist_path?: string;
    playlist_last_segment?: number;
    created?: number;
    start?: number;
    stop?: number;
    updated?: number;
    movement_key?: string;
    camera_key?: string;
    // Detection timing (camera movement detection)
    detection_started_at?: number;  // When movement was first detected
    detection_ended_at?: number;    // When movement ended (ENDLIST written)
    // Processing statistics (ML frame processing)
    frames_sent_to_ml?: number;     // Number of frames sent to ML detector
    frames_received_from_ml?: number; // Number of ML results received
    ml_total_processing_time_ms?: number; // Sum of all ML processing times
    ml_max_processing_time_ms?: number;   // Max single frame processing time
    /** Free-form debug note (e.g. "static_detection: airplane_arrived trackId=a0"). */
    notes?: string;
}

export interface MLTag {
    tag: string;
    maxProbability: number;
    count: number;
    maxProbabilityImage?: string;
}

export interface DetectionOutput {
    tags: MLTag[];
}

/** Disk cleanup status per camera, stored after each cleanup run */
export interface DiskStatusEntry {
    cameraKey: string;
    cameraName: string;
    lastRunAt: number;              // Timestamp when cleanup ran
    lastRunAt_en_GB: string;        // Human readable date
    filesDeleted: number;           // Number of files deleted for this camera
    bytesDeleted: number;           // Bytes deleted (from diskCheck folderStats)
    cutoffDate: number;             // Timestamp of newest deleted file
    cutoffDate_en_GB: string;       // Human readable cutoff date
    movementsDeleted: number;       // Number of movement records deleted
}

/** Aggregate disk status across all cameras */
export interface DiskStatus {
    lastRunAt: number;
    lastRunAt_en_GB: string;
    totalFilesDeleted: number;
    totalBytesDeleted: number;
    totalMovementsDeleted: number;
    perCamera: DiskStatusEntry[];
}

export interface CameraEntry {
    delete: boolean;
    name: string;
    folder: string;
    disk: string;
    ip?: string;
    passwd?: string;
    /** 
     * Optional direct URL for motion detection API.
     * If provided, used instead of constructing from ip/passwd.
     * Useful for testing or cameras with different API formats.
     */
    motionUrl?: string;
    /**
     * Stream source for ffmpeg input. Can be:
     * - RTSP URL: rtsp://user:pass@ip:554/path
     * - File path: /path/to/video.mp4 (loops with -stream_loop -1)
     * - Omitted: Constructs RTSP URL from ip/passwd fields
     */
    streamSource?: string;
    enable_streaming: boolean;
    enable_movement: boolean;
    /** Per-camera AI toggle. If false, motion events recorded but YOLO skipped. Default true. */
    enable_ai?: boolean;
    /**
     * Optional per-camera override for which YOLO classes to detect.
     * null/undefined = fall back to global Settings.aiEnabledClasses.
     */
    enabledClasses?: EnabledClasses | null;
    pollsWithoutMovement: number;
    secMaxSingleMovement: number;
    mSPollFrequency: number;
    segments_prior_to_movement: number;
    segments_post_movement: number;
    secMovementStartupDelay?: number;
    /** Processing pointer - last movement key that was processed for this camera (state, not config) */
    state_lastProcessedMovementKey?: string;
}

export interface CameraEntryClient extends Omit<CameraEntry, 'ip' | 'passwd'> {
    key: string;
}

export interface MovementToClient {
    key: string;
    movement: {
        cameraKey: string;
        startDate: number;
        startSegment: number | null;
        seconds: number;
        detection_status?: string;
        processing_state?: 'pending' | 'processing' | 'completed' | 'failed';
        detection_output?: DetectionOutput;
    };
    startDate_en_GB: string;
}

export interface SettingsCache {
    settings: Settings;
    status: SettingsStatus;
}

export interface SettingsStatus {
    nextCheckInMinutes: number;
    lastChecked?: Date;
    fail: boolean;
    error?: string;
}

export interface CameraCacheEntry {
    cameraEntry: CameraEntry;
    ffmpeg_task?: any;
    movementDetectionStatus?: any;
    lastMovementCheck?: number;
    streamStartedAt?: number;
}

export interface CameraCache {
    [key: string]: CameraCacheEntry;
}

// Epoch offset for movement keys (Sept 13, 2020)
const MOVEMENT_KEY_EPOCH = 1600000000;

// Helper functions for movement key encoding
const encodeMovementKey = (n: number): string => n.toString().padStart(12, '0');

/**
 * Get the frames output path based on settings
 */
function getFramesPath(settings: Settings, disk: string, folder: string): string {
    const baseDir = settings.disk_base_dir || disk;
    return settings.detection_frames_path
        ? `${baseDir}/${settings.detection_frames_path}`.replace(/\/+/g, '/')
        : `${disk}/${folder}`;
}

/**
 * Ensure directory exists, create if needed
 */
async function ensureDir(folder: string): Promise<boolean> {
    try {
        const stat = await fs.stat(folder);
        if (!stat.isDirectory()) {
            throw new Error(`${folder} is not a directory`);
        }
        return true;
    } catch (e: any) {
        if (e.code === 'ENOENT') {
            try {
                await fs.mkdir(folder);
                return true;
            } catch (mkdirError) {
                throw new Error(`Cannot create ${folder}: ${mkdirError}`);
            }
        } else {
            throw new Error(`Cannot stat ${folder}: ${e}`);
        }
    }
}

/**
 * Clear down disk space by removing old recordings
 */
async function clearDownDisk(
    diskDir: string,
    cameraKeys: string[],
    cleanupCapacity: number,
    cameraCache: CameraCache,
    settingsCache: SettingsCache,
    movementdb: any,
    logger: SimpleLogger
): Promise<DiskCheckReturn> {
    const cameraFolders = cameraKeys.map(key => `${diskDir}/${cameraCache[key].cameraEntry.folder}`);
    const mlFramesFolder = settingsCache.settings.detection_frames_path
        ? `${diskDir}/${settingsCache.settings.detection_frames_path}`.replace(/\/+/g, '/')
        : null;

    const foldersToClean = mlFramesFolder && !cameraFolders.includes(mlFramesFolder)
        ? [...cameraFolders, mlFramesFolder]
        : cameraFolders;

    const diskres = await diskCheck(diskDir, foldersToClean, cleanupCapacity);
    logger.info('Disk check complete', diskres);
    
    if (diskres.revmovedMBTotal > 0) {
        const mostRecentctimMs = Object.keys(diskres.folderStats).reduce(
            (acc, cur) => diskres.folderStats[cur].lastRemovedctimeMs
                ? (diskres.folderStats[cur].lastRemovedctimeMs > acc ? diskres.folderStats[cur].lastRemovedctimeMs : acc)
                : acc,
            0
        );
        
        if (mostRecentctimMs > 0 || cleanupCapacity === -1) {
            // Movement keys are stored as millisecond timestamps (e.g., "1766090503015")
            // Delete all movements with startDate <= mostRecentctimMs
            const keytoDeleteTo = cleanupCapacity === -1 ? null : mostRecentctimMs.toString();
            const deleteKeys: string[] = [];
            
            for await (const [encodedKey, value] of movementdb.iterator(keytoDeleteTo ? { lte: keytoDeleteTo } : {})) {
                if (cameraKeys.includes(value.cameraKey)) {
                    deleteKeys.push(encodedKey);
                }
            }

            if (deleteKeys.length > 0) {
                logger.info('Deleting old movements from database', { 
                    count: deleteKeys.length,
                    oldestDeletedKey: deleteKeys[0],
                    newestDeletedKey: deleteKeys[deleteKeys.length - 1]
                });
                await movementdb.batch(deleteKeys.map((k: string) => ({ type: 'del', key: k })) as any);
            }
        }
    }
    return diskres;
}

/** Simple logger interface for dependency injection (subset of winston Logger) */
export interface SimpleLogger {
    debug: (...args: any[]) => void;
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
}

export interface WebServerDependencies {
    logger: SimpleLogger;
    cameradb: any;
    movementdb: any;
    settingsdb: any;
    diskstatusdb: any;
    cameraCache: CameraCache;
    getSettingsCache: () => SettingsCache;
    setSettingsCache: (cache: SettingsCache) => void;
}

/**
 * Initialize and start the web server
 */
export async function initWeb(deps: WebServerDependencies, port: number = 8080): Promise<Server> {
    const { logger, cameradb, movementdb, settingsdb, diskstatusdb, cameraCache, getSettingsCache, setSettingsCache } = deps;

    const assets = new Router()
        .get('/image/:moment', async (ctx) => {
            const moment = ctx.params['moment'];

            try {
                const m: MovementEntry = await movementdb.get(encodeMovementKey(parseInt(moment)));
                if (!m) {
                    ctx.throw(404, `Movement not found: ${moment}`);
                    return;
                }
                const c: CameraEntry = await cameradb.get(m.cameraKey);
                if (!c) {
                    ctx.throw(404, `Camera not found: ${m.cameraKey}`);
                    return;
                }
                const hasDetections = m.detection_output?.tags && m.detection_output.tags.length > 0;
                const serve = `${c.disk}/${c.folder}/${hasDetections ? 'mlimage' : 'image'}${moment}.jpg`;
                await fs.stat(serve);
                ctx.set('content-type', 'image/jpeg');
                ctx.body = createReadStream(serve, { encoding: undefined });
            } catch (e) {
                const err: Error = e as Error;
                ctx.throw(400, err.message);
            }
        })
        .get('/frame/:moment/:filename', async (ctx) => {
            const moment = ctx.params['moment'];
            const filename = ctx.params['filename'];

            try {
                const m: MovementEntry = await movementdb.get(encodeMovementKey(parseInt(moment)));
                if (!m) {
                    ctx.throw(404, `Movement not found: ${moment}`);
                    return;
                }
                const { disk, folder } = cameraCache[m.cameraKey].cameraEntry;
                const framesPath = getFramesPath(getSettingsCache().settings, disk, folder);
                const serve = `${framesPath}/${filename}`;
                await fs.stat(serve);
                ctx.set('content-type', 'image/jpeg');
                ctx.body = createReadStream(serve, { encoding: undefined });
            } catch (e) {
                const err: Error = e as Error;
                ctx.throw(400, err.message);
            }
        })
        .get('/video/live/:cameraKey/:file', async (ctx) => {
            const cameraKey = ctx.params['cameraKey'];
            const file = ctx.params['file'];

            try {
                const c = await cameradb.get(cameraKey);
                if (!c) {
                    ctx.throw(404, `Camera not found: ${cameraKey}`);
                    return;
                }
                const serve = `${c.disk}/${c.folder}/${file}`;
                await fs.stat(serve);

                if (file.endsWith('.m3u8')) {
                    ctx.set('content-type', 'application/x-mpegURL');
                } else if (file.endsWith('.ts')) {
                    ctx.set('content-type', 'video/MP2T');
                } else {
                    ctx.throw(400, `unknown file=${file}`);
                }

                ctx.body = createReadStream(serve);
            } catch (e) {
                const err: Error = e as Error;
                ctx.throw(400, err.message);
            }
        })
        .get('/video/:startSegment/:seconds/:cameraKey/:file', async (ctx) => {
            const startSegment = ctx.params['startSegment'];
            const seconds = ctx.params['seconds'];
            const cameraKey = ctx.params['cameraKey'];
            const file = ctx.params['file'];

            const cameraEntry: CameraEntry = cameraCache[cameraKey].cameraEntry;

            if (file.endsWith('.m3u8')) {
                const segmentInt = parseInt(startSegment);
                const secondsInt = parseInt(seconds);
                if (isNaN(segmentInt) || isNaN(secondsInt)) {
                    ctx.throw(400, `message=${startSegment} or ${seconds} not valid values`);
                } else {
                    const preseq: number = ctx.query['preseq'] ? parseInt(ctx.query['preseq'] as any) : 0;
                    const postseq: number = ctx.query['postseq'] ? parseInt(ctx.query['postseq'] as any) : 0;
                    const segDuration: number = ctx.query['segDuration'] ? parseInt(ctx.query['segDuration'] as any) : 2;
                    const numSegments = Math.max(1, Math.round(secondsInt / segDuration) + preseq + postseq);

                    logger.debug('Generating playlist', {
                        cameraKey,
                        startSegment: segmentInt,
                        seconds: secondsInt,
                        preseq,
                        postseq,
                        numSegments,
                        firstSegment: segmentInt - preseq,
                        lastSegment: segmentInt + numSegments - preseq - 1
                    });

                    const body = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:${segDuration}
` + [...Array(numSegments).keys()].map(n => `#EXTINF:${segDuration}.000000,
stream${n + segmentInt - preseq}.ts`).join("\n") + "\n" + "#EXT-X-ENDLIST\n";

                    ctx.set('content-type', 'application/x-mpegURL');
                    ctx.body = body;
                }
            } else if (file.endsWith('.ts')) {
                const serve = `${cameraEntry.disk}/${cameraEntry.folder}/${file}`;
                try {
                    await fs.stat(serve);
                    ctx.set('content-type', 'video/MP2T');
                    ctx.body = createReadStream(serve);
                } catch (e) {
                    const err: Error = e as Error;
                    logger.warn('Video segment not found', {
                        file,
                        path: serve,
                        cameraKey,
                        error: err.message
                    });
                    ctx.throw(404, `Segment not found: ${file}`);
                }
            } else {
                ctx.throw(400, `unknown file=${file}`);
            }
        })
        .get('/mp4/:startSegment/:seconds/:cameraKey', async (ctx) => {
            const startSegment = ctx.params['startSegment'];
            const seconds = ctx.params['seconds'];
            const cameraKey = ctx.params['cameraKey'];

            try {
                const cameraEntry: CameraEntry = cameraCache[cameraKey].cameraEntry;
                const preseq: number = ctx.query['preseq'] ? parseInt(ctx.query['preseq'] as any) : 0;
                const postseq: number = ctx.query['postseq'] ? parseInt(ctx.query['postseq'] as any) : 0;
                const segDuration: number = ctx.query['segDuration'] ? parseInt(ctx.query['segDuration'] as any) : 0;
                const serve = `${cameraEntry.disk}/${cameraEntry.folder}/save${startSegment}-${seconds}.mp4`;
                const qs = [
                    preseq > 0 && `preseq=${preseq}`,
                    postseq > 0 && `postseq=${postseq}`,
                    segDuration > 0 && `segDuration=${segDuration}`
                ].filter(Boolean).join('&');

                const result = await runProcess({
                    name: `mp4-gen-${cameraKey}-${startSegment}`,
                    cmd: '/usr/bin/ffmpeg',
                    args: ['-y', '-i', `http://127.0.0.1:${port}/video/${startSegment}/${seconds}/${cameraKey}/stream.m3u8${qs ? `?${qs}` : ''}`, '-c', 'copy', serve],
                    timeout: 50000
                });

                if (result.code !== 0) {
                    throw new Error(`ffmpeg failed with code ${result.code}: ${result.stderr}`);
                }

                ctx.set('Content-Type', 'video/mp4');
                ctx.body = createReadStream(serve, { encoding: undefined });
            } catch (e) {
                ctx.throw(500, `error mp4 gen error=${e}`);
            }
        })
        .get('{/*path}', async (ctx) => {
            const path = ctx.params['path'];
            logger.debug('Serving static file', { path });
            await send(ctx, !path || path === "video_only" ? '/index.html' : path, { root: process.env['WEBPATH'] || './build' });
        });

    const api = new Router({ prefix: '/api' })
        .post('/settings', async (ctx) => {
            logger.info('Settings save', { settings: ctx.request.body });
            if (ctx.request.body) {
                const new_settings: Settings = ctx.request.body as Settings;
                // If the client omitted aiEnabledClasses (older UI), default to all enabled
                // so the API response is always self-describing.
                if (new_settings.aiEnabledClasses === undefined) {
                    new_settings.aiEnabledClasses = defaultEnabledClasses();
                }
                try {
                    const dirchk = await fs.stat(new_settings.disk_base_dir);
                    if (!dirchk.isDirectory()) throw new Error(`${new_settings.disk_base_dir} is not a directory`);
                    await settingsdb.put('config', new_settings);
                    const currentCache = getSettingsCache();
                    setSettingsCache({
                        ...currentCache,
                        settings: new_settings,
                        status: { ...currentCache.status, nextCheckInMinutes: new_settings.disk_cleanup_interval }
                    });
                    ctx.status = 201;
                } catch (err) {
                    ctx.body = err;
                    ctx.status = 500;
                }
            } else {
                ctx.body = 'no body';
                ctx.status = 500;
            }
        })
        .get('/diskstatus', async (ctx) => {
            // Return disk cleanup status for all cameras
            try {
                const perCamera: DiskStatusEntry[] = [];
                let totalFilesDeleted = 0;
                let totalBytesDeleted = 0;
                let totalMovementsDeleted = 0;
                let lastRunAt = 0;

                for await (const [, entry] of diskstatusdb.iterator()) {
                    perCamera.push(entry);
                    totalFilesDeleted += entry.filesDeleted || 0;
                    totalBytesDeleted += entry.bytesDeleted || 0;
                    totalMovementsDeleted += entry.movementsDeleted || 0;
                    if (entry.lastRunAt > lastRunAt) {
                        lastRunAt = entry.lastRunAt;
                    }
                }

                const lastRunAt_en_GB = lastRunAt > 0
                    ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(lastRunAt))
                    : 'Never';

                const diskStatus: DiskStatus = {
                    lastRunAt,
                    lastRunAt_en_GB,
                    totalFilesDeleted,
                    totalBytesDeleted,
                    totalMovementsDeleted,
                    perCamera
                };

                ctx.body = diskStatus;
            } catch (e) {
                logger.error('Error fetching disk status', { error: String(e) });
                ctx.body = { error: String(e) };
                ctx.status = 500;
            }
        })
        .get('/stats', async (ctx) => {
            // On-demand DB stats — scans movementdb to compute per-camera and per-day counts
            try {
                // Plan 8: also tally today's static_event arrivals/departures per camera.
                // System tz is Asia/Taipei (set globally per nvr-known-issues.md), so
                // `new Date()` here reflects local "today" without further conversion.
                const todayStart = (() => {
                    const now = new Date();
                    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
                })();

                const perCamera: {
                    [cameraKey: string]: {
                        total: number; oldest: number; newest: number;
                        perDay: { [day: string]: number };
                        staticToday: { arrivals: number; departures: number };
                    }
                } = {};

                for await (const [key, value] of movementdb.iterator()) {
                    const cam = value.cameraKey || 'unknown';
                    if (!perCamera[cam]) {
                        perCamera[cam] = {
                            total: 0, oldest: Number(key), newest: Number(key),
                            perDay: {}, staticToday: { arrivals: 0, departures: 0 },
                        };
                    }
                    const entry = perCamera[cam];
                    entry.total++;
                    const ts = Number(key);
                    if (ts < entry.oldest) entry.oldest = ts;
                    if (ts > entry.newest) entry.newest = ts;
                    const day = new Intl.DateTimeFormat('en-GB', { dateStyle: 'short' }).format(new Date(ts));
                    entry.perDay[day] = (entry.perDay[day] || 0) + 1;

                    // Plan 8: count today's static_event records. Read the dedicated
                    // `event` field (added 2026-07-13) when present; fall back to
                    // parsing the human-readable `notes` string for older records
                    // written before the dedicated field existed.
                    if (value.detection_status === 'static_event' && ts >= todayStart) {
                        const ev = (value as any).event as string | undefined;
                        if (ev === 'arrived') {
                            entry.staticToday.arrivals += 1;
                        } else if (ev === 'departed') {
                            entry.staticToday.departures += 1;
                        } else {
                            const notes = (value as any).notes || '';
                            if (notes.includes('airplane_arrival')) entry.staticToday.arrivals += 1;
                            else if (notes.includes('airplane_departure')) entry.staticToday.departures += 1;
                        }
                    }
                }

                // Add camera names from cache
                const cameras: {
                    cameraKey: string; cameraName: string; total: number;
                    oldest: string; newest: string;
                    perDay: { date: string; count: number }[];
                    staticToday: { arrivals: number; departures: number };
                }[] = [];
                for (const [cameraKey, stats] of Object.entries(perCamera)) {
                    const cameraName = cameraCache[cameraKey]?.cameraEntry?.name || cameraKey;
                    const fmt = (ts: number) => ts > 0
                        ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(ts))
                        : 'N/A';
                    cameras.push({
                        cameraKey,
                        cameraName,
                        total: stats.total,
                        oldest: fmt(stats.oldest),
                        newest: fmt(stats.newest),
                        perDay: Object.entries(stats.perDay)
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([date, count]) => ({ date, count })),
                        staticToday: stats.staticToday,
                    });
                }

                const totalMovements = cameras.reduce((sum, c) => sum + c.total, 0);
                const totalCameras = Object.keys(cameraCache).filter(k => !cameraCache[k].cameraEntry.delete).length;

                ctx.body = { totalCameras, totalMovements, cameras };
            } catch (e) {
                logger.error('Error computing stats', { error: String(e) });
                ctx.body = { error: String(e) };
                ctx.status = 500;
            }
        })
        .get('/cameras/config', async (ctx) => {
            // Internal endpoint: returns camera streamSource (RTSP URL) for internal tools
            // like motion_proxy. NOTE: includes credentials, do not expose to internet.
            try {
                const configs: { name: string; folder: string; key: string; streamSource: string; enable_streaming: boolean }[] = [];
                for (const [cameraKey, entry] of Object.entries(cameraCache)) {
                    const ce = entry.cameraEntry;
                    if (ce.delete) continue;
                    const streamSource = ce.streamSource ||
                        `rtsp://admin:${ce.passwd}@${ce.ip}:554/h264Preview_01_main`;
                    configs.push({
                        name: ce.name,
                        folder: ce.folder,
                        key: cameraKey,
                        streamSource,
                        enable_streaming: ce.enable_streaming !== false
                    });
                }
                ctx.body = { cameras: configs };
            } catch (e) {
                logger.error('Error reading camera config', { error: String(e) });
                ctx.body = { error: String(e) };
                ctx.status = 500;
            }
        })
        .post('/detect', async (ctx) => {
            // Proxy detection requests to live-detector service
            const body = ctx.request.body as { cameraKey?: string; image?: string };
            if (!body?.cameraKey || !body?.image) {
                ctx.body = { error: 'cameraKey and image required' };
                ctx.status = 400;
                return;
            }
            try {
                // Resolve per-camera + global class filter so live bbox
                // overlay honors the user's enabled-classes setting.
                const ce = cameraCache[body.cameraKey]?.cameraEntry;
                const enabledCsv = ce
                    ? enabledClassesToCsv(resolveEnabledClasses(
                          ce,
                          getSettingsCache().settings.aiEnabledClasses ?? null,
                      ))
                    : '';
                const postData = JSON.stringify({
                    cameraKey: body.cameraKey,
                    image: body.image,
                    enabledClasses: enabledCsv,
                });
                const options = {
                    hostname: '127.0.0.1',
                    port: 9999,
                    path: '/detect',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
                };
                const result = await new Promise<any>((resolve, reject) => {
                    const req = http.request(options, (res) => {
                        let data = '';
                        res.on('data', chunk => { data += chunk; });
                        res.on('end', () => {
                            try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid response')); }
                        });
                    });
                    req.on('error', reject);
                    req.write(postData);
                    req.end();
                });
                ctx.body = result;
            } catch (e) {
                logger.error('Detect proxy error', { error: String(e) });
                ctx.body = { error: 'Detection service unavailable', bboxes: [] };
                ctx.status = 503;
            }
        })
        .post('/diskcleanup', async (ctx) => {
            // Force run disk cleanup with optional target capacity
            const targetCapacity = ctx.request.query['target']
                ? parseInt(ctx.request.query['target'] as string, 10)
                : null;
            
            const settingsCache = getSettingsCache();
            const { settings } = settingsCache;
            
            if (!settings.disk_base_dir) {
                ctx.body = { error: 'Disk base directory not configured' };
                ctx.status = 400;
                return;
            }

            // Use target from query param, or current setting, default to 90%
            const cleanupCapacity = targetCapacity ?? settings.disk_cleanup_capacity ?? 90;
            
            logger.info('Manual disk cleanup triggered', { targetCapacity: cleanupCapacity });

            try {
                const cameraKeys = Object.keys(cameraCache).filter(
                    c => (!cameraCache[c].cameraEntry.delete) && cameraCache[c].cameraEntry.enable_streaming
                );

                const diskres = await clearDownDisk(
                    settings.disk_base_dir,
                    cameraKeys,
                    cleanupCapacity,
                    cameraCache,
                    settingsCache,
                    movementdb,
                    logger
                );

                // Save disk status per camera
                const now = Date.now();
                const nowFormatted = new Intl.DateTimeFormat('en-GB', {
                    dateStyle: 'short', timeStyle: 'short', hour12: false
                }).format(new Date(now));

                for (const cameraKey of cameraKeys) {
                    const folder = `${settings.disk_base_dir}/${cameraCache[cameraKey].cameraEntry.folder}`;
                    const folderStats = diskres.folderStats[folder];
                    const cutoffDate = folderStats?.lastRemovedctimeMs || 0;
                    const cutoffFormatted = cutoffDate > 0
                        ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(cutoffDate))
                        : 'N/A';

                    await diskstatusdb.put(cameraKey, {
                        cameraKey,
                        cameraName: cameraCache[cameraKey].cameraEntry.name,
                        lastRunAt: now,
                        lastRunAt_en_GB: nowFormatted,
                        filesDeleted: folderStats?.removedFiles || 0,
                        bytesDeleted: folderStats?.removedMB || 0,
                        cutoffDate,
                        cutoffDate_en_GB: cutoffFormatted,
                        movementsDeleted: 0,
                    });
                }

                logger.info('Manual disk cleanup complete', { removedMB: diskres.revmovedMBTotal });

                ctx.body = { 
                    success: true, 
                    targetCapacity: cleanupCapacity,
                    removedMB: diskres.revmovedMBTotal,
                    folderStats: diskres.folderStats
                };
            } catch (e: any) {
                logger.error('Manual disk cleanup failed', { error: String(e) });
                ctx.body = { error: String(e) };
                ctx.status = 500;
            }
        })
        .post('/static-event', async (ctx) => {
            // Receive a static detection event (e.g., airplane arrived/departed at tarmac)
            // from an external Python service. We persist it as a movement so /api/movements
            // and the UI timeline pick it up automatically.
            //
            // Why IPC: the external service cannot open mydb itself because leveldb LOCK
            // is held by this NVR server process. POSTing here reuses our open handle.
            const body = ctx.request.body as {
                cameraKey?: string;
                cameraName?: string;
                event?: string;       // 'arrived' | 'departed'
                trackId?: string;
                source?: string;       // optional origin tag
            };
            const cameraKey = body?.cameraKey;
            const cameraName = body?.cameraName || cameraKey;
            const eventName = body?.event;
            const trackId = body?.trackId;
            if (!cameraKey || !eventName || !trackId) {
                ctx.status = 400;
                ctx.body = { error: 'cameraKey, event, trackId are required' };
                return;
            }
            if (eventName !== 'arrived' && eventName !== 'departed') {
                ctx.status = 400;
                ctx.body = { error: `invalid event: ${eventName} (must be arrived|departed)` };
                return;
            }
            const now = Date.now();
            const movementKey = encodeMovementKey(now);
            const movement: MovementEntry = {
                cameraKey,
                startDate: now,
                startSegment: null,
                seconds: 1,
                pollCount: 1,
                consecutivePollsWithoutMovement: 0,
                processing_state: 'completed',
                detection_status: 'static_event',
                // Plan 8 bugfix: store the event type as a dedicated top-level field
                // so /api/stats can tally arrivals/departures without parsing the
                // human-readable `notes` string. Values: 'arrived' | 'departed'.
                event: eventName,
                track_id: trackId,
                detection_started_at: now,
                detection_ended_at: now,
                processing_completed_at: now,
                created: now,
                updated: now,
                movement_key: movementKey,
                camera_key: cameraKey,
                start: now,
                stop: now,
                detection_output: {
                    tags: [{
                        tag: 'aeroplane',
                        maxProbability: 0,
                        count: 1,
                    }],
                },
                notes: `static_detection: airplane_${eventName} (${body?.source || 'static_detector'} trackId=${trackId})`,
            };
            try {
                await movementdb.put(movementKey, movement);
                logger.info('Static event recorded', { cameraKey, event: eventName, trackId, movementKey });
                ctx.status = 201;
                ctx.body = { ok: true, movementKey, event: eventName, trackId };
            } catch (e: any) {
                logger.error('Static event write failed', { error: String(e) });
                ctx.status = 500;
                ctx.body = { error: String(e) };
            }
        })
        .post('/camera/:id/analyze', async (ctx) => {
            const cameraKey = ctx.params['id'];
            try {
                const cam: CameraEntry = await cameradb.get(cameraKey);
                if (!cam || cam.delete) {
                    ctx.body = { error: 'Camera not found' };
                    ctx.status = 404;
                    return;
                }
                const { spawn } = await import('node:child_process');
                const pathMod = await import('node:path');
                const analyzerPath = pathMod.join(process.cwd(), 'ai', 'detector', 'analyze.py');
                const ipAddr = cam.ip || '';
                const child = spawn('python3', [analyzerPath, ipAddr, '80', 'admin', cam.passwd || ''], {
                    cwd: process.cwd(),
                    timeout: 60000,
                });
                let stdout = '';
                let stderr = '';
                child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
                child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
                const exitCode: number = await new Promise((resolve) => {
                    child.on('close', (code) => resolve(code ?? -1));
                    child.on('error', () => resolve(-1));
                });
                if (exitCode !== 0) {
                    logger.error('Camera analyzer failed', { cameraKey, exitCode, stderr });
                    ctx.body = { error: 'Analyzer failed', stderr, exitCode };
                    ctx.status = 502;
                    return;
                }
                try {
                    const result = JSON.parse(stdout);
                    ctx.body = result;
                } catch (parseErr) {
                    logger.error('Camera analyzer invalid JSON', { cameraKey, stdout: stdout.slice(0, 500), stderr });
                    ctx.body = { error: 'Invalid analyzer JSON output', stdout, stderr };
                    ctx.status = 500;
                }
            } catch (e) {
                logger.error('Camera analyze error', { cameraKey, error: String(e) });
                ctx.body = { error: String(e) };
                ctx.status = 500;
            }
        })
        .post('/camera/:id', async (ctx) => {
            const cameraKey = ctx.params['id'];
            const deleteOption = ctx.request.query['delopt'];

            logger.info('Camera save', { cameraKey, deleteOption, camera: ctx.request.body });
            if (ctx.request.body) {
                const new_ce: CameraEntry = ctx.request.body as CameraEntry;
                const folder = `${new_ce.disk}/${new_ce.folder}`;
                
                if (cameraKey === 'new') {
                    try {
                        await ensureDir(folder);
                        const new_key = "C" + ((Date.now() / 1000 | 0) - MOVEMENT_KEY_EPOCH);
                        // Initialize processing pointer for new camera
                        const newCamera: CameraEntry = { 
                            delete: false, 
                            ...new_ce,
                            state_lastProcessedMovementKey: '0'  // Start from beginning
                        };
                        await cameradb.put(new_key, newCamera);
                        cameraCache[new_key] = { cameraEntry: new_ce };
                        ctx.status = 201;
                    } catch (e) {
                        ctx.throw(400, e as Error);
                    }
                } else {
                    try {
                        const old_cc: CameraCacheEntry = cameraCache[cameraKey];
                        if (!old_cc) throw new Error(`camera ${cameraKey} not found`);

                        if (!deleteOption) {
                            await ensureDir(folder);
                        }

                        logger.info('Stopping existing camera processes', {
                            camera: old_cc.cameraEntry.name,
                            cameraKey,
                            hasFFmpegTask: !!old_cc.ffmpeg_task
                        });

                        cameraCache[cameraKey] = {
                            ...cameraCache[cameraKey],
                            cameraEntry: { ...old_cc.cameraEntry, enable_streaming: false },
                        };

                        if (old_cc.ffmpeg_task && old_cc.ffmpeg_task.exitCode === null) {
                            logger.info('Terminating ffmpeg streaming process', {
                                camera: old_cc.cameraEntry.name,
                                pid: old_cc.ffmpeg_task.pid
                            });

                            await new Promise<void>((resolve) => {
                                const timeout = setTimeout(() => {
                                    logger.warn('ffmpeg termination timeout - forcing', {
                                        camera: old_cc.cameraEntry.name,
                                        cameraKey
                                    });
                                    resolve();
                                }, 5000);

                                old_cc.ffmpeg_task.once('close', () => {
                                    clearTimeout(timeout);
                                    logger.info('ffmpeg streaming process terminated', {
                                        camera: old_cc.cameraEntry.name,
                                        cameraKey
                                    });
                                    resolve();
                                });

                                old_cc.ffmpeg_task.kill();
                            });
                        }

                        if (!deleteOption) {
                            // Preserve state_ fields - don't let client overwrite them
                            const { state_lastProcessedMovementKey: _drop, ...clientData } = new_ce as CameraEntry & { state_lastProcessedMovementKey?: string };
                            // The Edit panel never round-trips the real password.
                            // It shows a "<set>" sentinel when a password already
                            // exists, or an empty placeholder. Treat either of
                            // those as "keep the existing password".
                            if (clientData.passwd === '<set>' || clientData.passwd === '') {
                                if (old_cc.cameraEntry.passwd) {
                                    clientData.passwd = old_cc.cameraEntry.passwd;
                                }
                            }
                            const new_vals: CameraEntry = {
                                ...old_cc.cameraEntry,
                                ...clientData,
                                // Preserve existing state fields
                                state_lastProcessedMovementKey: old_cc.cameraEntry.state_lastProcessedMovementKey
                            };
                            await cameradb.put(cameraKey, new_vals);
                            cameraCache[cameraKey] = { cameraEntry: new_vals };

                            logger.info('Camera configuration updated', {
                                camera: new_vals.name,
                                cameraKey,
                                streaming: new_vals.enable_streaming,
                                movement: new_vals.enable_movement
                            });

                            ctx.status = 201;
                        } else {
                            logger.info('Camera operation', {
                                camera: old_cc.cameraEntry.name,
                                cameraKey,
                                deleteOption
                            });

                            if (deleteOption === 'reset') {
                                logger.info('Resetting camera recordings', { cameraKey });
                                const currentSettings = getSettingsCache();
                                const diskres = await clearDownDisk(
                                    currentSettings.settings.disk_base_dir,
                                    [cameraKey],
                                    -1,
                                    cameraCache,
                                    currentSettings,
                                    movementdb,
                                    logger
                                );
                                logger.info('Camera movement files deleted', { cameraKey, diskres });

                                const movementsToDelete: string[] = [];
                                for await (const [key, movement] of movementdb.iterator()) {
                                    if (movement.cameraKey === cameraKey) {
                                        movementsToDelete.push(key);
                                    }
                                }

                                if (movementsToDelete.length > 0) {
                                    await movementdb.batch(movementsToDelete.map((k: string) => ({ type: 'del', key: k })) as any);
                                }

                                logger.info('Camera movements deleted from database', {
                                    cameraKey,
                                    count: movementsToDelete.length
                                });
                                ctx.status = 200;
                            } else if (deleteOption === 'delall') {
                                const currentSettings = getSettingsCache();
                                const diskres = await clearDownDisk(
                                    currentSettings.settings.disk_base_dir,
                                    [cameraKey],
                                    -1,
                                    cameraCache,
                                    currentSettings,
                                    movementdb,
                                    logger
                                );
                                logger.info('Camera files deleted', { cameraKey, diskres });
                            }

                            if (deleteOption === 'del' || deleteOption === 'delall') {
                                const new_vals: CameraEntry = { ...old_cc.cameraEntry, delete: true };
                                await cameradb.put(cameraKey, new_vals);
                                cameraCache[cameraKey] = { cameraEntry: new_vals };

                                logger.info('Camera marked as deleted', {
                                    camera: new_vals.name,
                                    cameraKey
                                });

                                ctx.status = 200;
                            } else if (deleteOption !== 'reset') {
                                logger.warn('Unknown delete option', { deleteOption });
                                ctx.status = 400;
                            }
                        }
                    } catch (e) {
                        logger.error('Camera update error', { error: String(e) });
                        ctx.throw(400, e as Error);
                    }
                }
            } else {
                ctx.status = 500;
            }
        })
        .get('/movements/stream', (ctx) => {
            sseManager.addClient(ctx);
        })
        .get('/movements', async (ctx) => {
            const mode = ctx.query['mode'];
            const limitParam = ctx.query['limit'];
            const cursorParam = ctx.query['cursor']; // Last key from previous page for pagination
            const onlyStaticParam = ctx.query['onlyStatic']; // Static-event-only filter (Plan 8)
            const onlyStatic = onlyStaticParam === 'true' || onlyStaticParam === '1';
            const limit = limitParam ? Math.min(parseInt(limitParam as string, 10) || 1000, 10000) : 1000;
            
            const cameras: CameraEntryClient[] = Object.entries(cameraCache)
                .filter(([_, value]) => !value.cameraEntry.delete)
                .map(([key, value]) => {
                    const { cameraEntry } = value;
                    // Return ip and passwd so the Edit Camera panel can pre-fill
                    // the IP/Password/StreamSource/MotionUrl fields. For passwd,
                    // we return a sentinel ('<set>') so the UI knows a password
                    // exists without exposing it in plaintext. Users re-enter to
                    // change it; if they submit without changes, the existing
                    // password is kept (see POST /api/camera/:id).
                    const clientCameraEntry = {
                        ...cameraEntry,
                        passwd: cameraEntry.passwd ? '<set>' : '',
                    };
                    return { key, ...clientCameraEntry } as CameraEntryClient;
                });

            ctx.response.set("content-type", "application/json");
            ctx.body = await new Promise(async (res) => {
                let movements: MovementToClient[] = [];
                let nextCursor: string | null = null;
                let hasMore = false;

                if (mode === "Time") {
                    for (const c of cameras) {
                        const listfiles = await catalogVideo(`${c.disk}/${c.folder}`);
                        // Time mode implementation - currently empty per original
                    }
                    res({ config: getSettingsCache(), cameras, movements, hasMore: false, nextCursor: null });
                } else {
                    // Build iterator options: reverse order, with optional cursor for pagination
                    const iteratorOpts: { reverse: boolean; limit: number; lt?: string } = { 
                        reverse: true, 
                        limit: limit * 10  // Fetch extra to handle filtering
                    };
                    
                    // If cursor provided, start from just before that key
                    if (cursorParam && typeof cursorParam === 'string') {
                        iteratorOpts.lt = cursorParam;
                    }

                    for await (const [key, value] of movementdb.iterator(iteratorOpts)) {
                        const { detection_output } = value;

                        // Plan 8: ?onlyStatic=true skips non-static-event records so the
                        // UI's "只看靜止事件" toggle can re-use this endpoint.
                        if (onlyStatic && value.detection_status !== 'static_event') continue;

                        let tags = detection_output?.tags || null;
                        if (mode === 'Filtered') {
                            const { detection_tag_filters } = getSettingsCache().settings || {};
                            if (!detection_tag_filters || detection_tag_filters.length === 0) {
                                tags = [];
                            } else if (tags && Array.isArray(tags) && tags.length > 0) {
                                tags = tags.filter((t: MLTag) => {
                                    const filter = detection_tag_filters.find(f => f.tag === t.tag);
                                    return filter ? t.maxProbability >= filter.minProbability : false;
                                });
                            } else {
                                tags = [];
                            }
                        }
                        
                        if (mode === 'Movement' || (mode === 'Filtered' && tags && tags.length > 0)) {
                            if (!value.startDate || isNaN(value.startDate)) continue;
                            const startDate = new Date(value.startDate);
                            if (isNaN(startDate.getTime())) continue;

                            // Check if we've reached the limit - if so, mark hasMore and set cursor
                            if (movements.length >= limit) {
                                hasMore = true;
                                nextCursor = key;
                                break;
                            }

                            movements.push({
                                key,
                                startDate_en_GB: new Intl.DateTimeFormat('en-GB', {
                                    ...(startDate.toDateString() !== (new Date()).toDateString() && { weekday: "short" }),
                                    minute: "2-digit",
                                    hour: "2-digit",
                                    hour12: false
                                }).format(startDate),
                                movement: {
                                    cameraKey: value.cameraKey,
                                    startDate: value.startDate,
                                    startSegment: value.startSegment,
                                    seconds: value.seconds,
                                    detection_status: value.detection_status || 'complete',
                                    processing_state: value.processing_state,
                                    // Detection fields
                                    ...(value.pollCount !== undefined && { pollCount: value.pollCount }),
                                    ...(value.consecutivePollsWithoutMovement !== undefined && { consecutivePollsWithoutMovement: value.consecutivePollsWithoutMovement }),
                                    ...(value.playlist_path && { playlist_path: value.playlist_path }),
                                    ...(value.playlist_last_segment !== undefined && { playlist_last_segment: value.playlist_last_segment }),
                                    ...(value.processing_error && { processing_error: value.processing_error }),
                                    ...(tags && tags.length > 0 && { detection_output: { tags } }),
                                    // Timing fields
                                    ...(value.detection_started_at && { detection_started_at: value.detection_started_at }),
                                    ...(value.detection_ended_at && { detection_ended_at: value.detection_ended_at }),
                                    ...(value.processing_started_at && { processing_started_at: value.processing_started_at }),
                                    ...(value.processing_completed_at && { processing_completed_at: value.processing_completed_at }),
                                    // ML stats
                                    ...(value.frames_sent_to_ml !== undefined && { frames_sent_to_ml: value.frames_sent_to_ml }),
                                    ...(value.frames_received_from_ml !== undefined && { frames_received_from_ml: value.frames_received_from_ml }),
                                    ...(value.ml_total_processing_time_ms !== undefined && { ml_total_processing_time_ms: value.ml_total_processing_time_ms }),
                                    ...(value.ml_max_processing_time_ms !== undefined && { ml_max_processing_time_ms: value.ml_max_processing_time_ms }),
                                    // Plan 8 bugfix: surface the `notes` field so the UI badge can
                                    // distinguish airplane_arrival vs airplane_departure. Before
                                    // this fix the field existed in DB but was silently dropped
                                    // by the response serializer.
                                    ...(value.notes && { notes: value.notes })
                                }
                            });
                        }
                    }
                    res({ config: getSettingsCache(), cameras, movements, hasMore, nextCursor });
                }
            });
        });

    const nav = new Router()
        .get('/metrics', async (ctx) => {
            ctx.set('Content-Type', registry.contentType);
            ctx.body = await registry.metrics();
        });

    const app = new Koa();

    // Global error handler
    app.on('error', (err, ctx) => {
        if (err.code === 'ECONNRESET' ||
            err.code === 'EPIPE' ||
            err.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
            err.message?.includes('Premature close')) {
            logger.debug('Client disconnected', {
                path: ctx.path,
                error: err.code || err.message
            });
            return;
        }

        logger.error('Application error', {
            error: err.message,
            stack: err.stack,
            path: ctx.path,
            method: ctx.method
        });
    });

    app.use(bodyParser());
    app.use(api.routes());
    app.use(nav.routes());
    app.use(assets.routes());

    logger.info('NVR Server starting', { port });
    const server = app.listen(port);

    return server;
}

export { clearDownDisk, ensureDir, getFramesPath, encodeMovementKey, MOVEMENT_KEY_EPOCH };
