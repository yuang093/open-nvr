/**
 * VideoWithOverlay
 * Wraps VideoJS with real-time bbox overlay using SVG.
 * Captures frames from the video element and sends them to the live-detector server.
 */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import Hls from 'hls.js';

const DETECTOR_INTERVAL = 2000; // ms between detection requests
const DETECTOR_URL = 'http://127.0.0.1:9999/detect';
const MIN_PROBABILITY = 0.25;

export const VideoWithOverlay = ({ options, onReady, play, imageUrl }) => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const hlsRef = useRef(null);
  const detectionTimerRef = useRef(null);
  const [isLive, setIsLive] = useState(false);
  const [bboxes, setBboxes] = useState([]); // {object, box:[x1,y1,x2,y2], probability}
  const currentCameraRef = useRef(null);

  // Sync video aspect ratio to overlay
  const updateOverlaySize = useCallback(() => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay) return;
    const rect = video.getBoundingClientRect();
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }, []);

  // Capture current frame as base64 JPEG
  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return null;

    const vidW = video.videoWidth;
    const vidH = video.videoHeight;
    if (!vidW || !vidH) return null;

    canvas.width = vidW;
    canvas.height = vidH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, vidW, vidH);
    return canvas.toDataURL('image/jpeg', 0.6);
  }, []);

  // Send frame to detector and update bboxes
  const runDetection = useCallback(async () => {
    const cameraKey = currentCameraRef.current;
    if (!cameraKey) return;

    const frameData = captureFrame();
    if (!frameData) return;

    try {
      const resp = await fetch(DETECTOR_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cameraKey, image: frameData })
      });
      if (!resp.ok) return;
      const result = await resp.json();
      if (result.bboxes && result.bboxes.length > 0) {
        setBboxes(prev => {
          // Only update if meaningfully different
          const incoming = result.bboxes.map((b) => b.object + ':' + b.box.join(',')).join('|');
          const current = prev.map((b) => b.object + ':' + b.box.join(',')).join('|');
          return incoming !== current ? result.bboxes : prev;
        });
      } else {
        setBboxes([]);
      }
    } catch (e) {
      // Detector not available or error
    }
  }, [captureFrame]);

  // Start/stop detection based on live mode
  useEffect(() => {
    if (!isLive || imageUrl) {
      // Stop detection
      if (detectionTimerRef.current) {
        clearInterval(detectionTimerRef.current);
        detectionTimerRef.current = null;
      }
      setBboxes([]);
      return;
    }

    // Start detection loop
    runDetection();
    detectionTimerRef.current = setInterval(runDetection, DETECTOR_INTERVAL);
    return () => {
      if (detectionTimerRef.current) clearInterval(detectionTimerRef.current);
    };
  }, [isLive, imageUrl, runDetection]);

  // Handle play changes from parent
  useEffect(() => {
    if (!play) return;
    const { cKey, mKey } = play;
    // cKey tells us which camera is playing
    currentCameraRef.current = cKey || null;

    const isLiveStream = !mKey;
    setIsLive(isLiveStream);

    if (!isLiveStream) {
      setBboxes([]);
    }
  }, [play]);

  // Handle video events
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleResize = () => updateOverlaySize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [updateOverlaySize]);

  // HLS initialization
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90,
        liveSyncDuration: 3,
        liveMaxLatencyDuration: 10
      });
      hlsRef.current = hls;
      hls.attachMedia(video);

      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        console.log('HLS: media attached');
        onReady && onReady(video, hls);
      });

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setIsLive(true);
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              hls.destroy();
              break;
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      onReady && onReady(video, null);
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [onReady]);

  // Handle play changes - load video source
  useEffect(() => {
    if (!play) return;

    const { cKey, mKey, mStartSegment, mSeconds, segments_prior_to_movement } = play;
    const video = videoRef.current;
    const hls = hlsRef.current;
    if (!video) return;

    const isLiveStream = !mKey;
    setIsLive(isLiveStream);

    const queryParams = mKey ? [
      segments_prior_to_movement && `preseq=${segments_prior_to_movement}`,
    ].filter(Boolean).join('&') : '';
    const src = `/video/${mKey ? `${mStartSegment}/${mSeconds}` : 'live'}/${cKey}/stream.m3u8${queryParams ? `?${queryParams}` : ''}`;

    if (hls) {
      hls.loadSource(src);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
    }

    if (mKey && segments_prior_to_movement) {
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = segments_prior_to_movement * 2;
      }, { once: true });
    }

    video.play().catch(() => {});
  }, [play]);

  // Build SVG bboxes
  const renderBboxes = () => {
    if (!bboxes || bboxes.length === 0) return null;
    const video = videoRef.current;
    if (!video) return null;

    const rect = video.getBoundingClientRect();
    const vidW = video.videoWidth || 640;
    const vidH = video.videoHeight || 480;

    return bboxes.map((bbox, i) => {
      if (bbox.probability < MIN_PROBABILITY) return null;
      const [x1, y1, x2, y2] = bbox.box;
      // Scale bbox to current video display size
      const scaleX = rect.width / vidW;
      const scaleY = rect.height / vidH;
      const sx1 = x1 * scaleX;
      const sy1 = y1 * scaleY;
      const sx2 = x2 * scaleX;
      const sy2 = y2 * scaleY;
      const w = sx2 - sx1;
      const h = sy2 - sy1;

      const color = getBboxColor(bbox.object);
      const label = `${bbox.object} ${(bbox.probability * 100).toFixed(0)}%`;

      return (
        <g key={i}>
          <rect
            x={sx1} y={sy1} width={w} height={h}
            fill="none" stroke={color} strokeWidth={2}
          />
          <rect
            x={sx1} y={Math.max(sy1 - 18, 0)} width={Math.min(label.length * 7 + 6, w)} height={18}
            fill={color}
          />
          <text
            x={sx1 + 3} y={sy1 - 4}
            fill="white" fontSize="11" fontFamily="sans-serif"
          >
            {label}
          </text>
        </g>
      );
    });
  };

  return (
    <div className="video-container" style={{ position: 'relative' }}>
      {imageUrl ? (
        <img src={imageUrl} alt="Detection frame" style={{ display: 'block', height: '100vh', width: 'auto' }} />
      ) : (
        <>
          <video
            ref={videoRef}
            controls
            autoPlay
            muted
            className={isLive ? 'live-stream' : ''}
            style={{ display: 'block', height: '100vh', maxHeight: 'calc((100vw - 350px) * 3 / 4)', width: 'auto', aspectRatio: '4/3', objectFit: 'contain' }}
            onLoadedMetadata={() => updateOverlaySize()}
            onPlay={() => updateOverlaySize()}
          />
          {/* Hidden canvas for frame capture */}
          <canvas ref={canvasRef} style={{ display: 'none' }} />
          {/* SVG overlay */}
          <svg
            ref={overlayRef}
            style={{
              position: 'absolute',
              top: 0, left: 0,
              width: '100%', height: '100%',
              pointerEvents: 'none',
              overflow: 'visible'
            }}
          >
            {renderBboxes()}
          </svg>
          {/* LIVE badge */}
          {isLive && (
            <div style={{
              position: 'absolute', top: '10px', left: '10px',
              background: 'rgba(255, 0, 0, 0.8)', color: 'white',
              padding: '4px 8px', borderRadius: '4px',
              fontSize: '12px', fontWeight: 'bold',
              pointerEvents: 'none'
            }}>
              ● LIVE
            </div>
          )}
        </>
      )}
    </div>
  );
};

// Color map for different object classes
function getBboxColor(object) {
  const colors: Record<string, string> = {
    person: '#00FF00',
    car: '#0088FF',
    truck: '#FF8800',
    bus: '#FF8800',
    motorbike: '#00CCFF',
    bicycle: '#00CCFF',
    aeroplane: '#FF4444',
    train: '#AA44FF',
    boat: '#44AAFF',
    bird: '#FFFF00',
    cat: '#FF00FF',
    dog: '#FF00FF',
    horse: '#AA0000',
    sheep: '#AAAAAA',
    cow: '#884400',
  };
  return colors[object.toLowerCase()] || '#FFFF00';
}
