/**
 * VideoWithOverlay
 * Wraps live camera video with real-time bbox overlay via SVG.
 * Frame capture → POST to live-detector → render bboxes as SVG.
 */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import Hls from 'hls.js';

const DETECTOR_INTERVAL = 2000;
const DETECTOR_URL = 'http://127.0.0.1:9999/detect';
const MIN_PROB = 0.25;

export function VideoWithOverlay({ onReady, play, imageUrl }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const hlsRef = useRef(null);
  const detectTimerRef = useRef(null);
  const [bboxes, setBboxes] = useState([]);
  const currentCameraRef = useRef(null);

  // Keep overlay sized to video
  const updateOverlaySize = useCallback(() => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay) return;
    const rect = video.getBoundingClientRect();
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  }, []);

  // Capture current video frame as base64 JPEG
  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return null;
    const vidW = video.videoWidth;
    const vidH = video.videoHeight;
    if (!vidW || !vidH) return null;
    canvas.width = vidW;
    canvas.height = vidH;
    canvas.getContext('2d').drawImage(video, 0, 0, vidW, vidH);
    return canvas.toDataURL('image/jpeg', 0.6);
  }, []);

  // Run detection on current frame
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
        setBboxes(result.bboxes);
      } else {
        setBboxes([]);
      }
    } catch (_) {
      // detector unavailable - silent
    }
  }, [captureFrame]);

  // Main effect: handle play changes + HLS init
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!play) {
      // Stop playback
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      if (detectTimerRef.current) { clearInterval(detectTimerRef.current); detectTimerRef.current = null; }
      setBboxes([]);
      return;
    }

    const { cKey, mKey, mStartSegment, mSeconds, segments_prior_to_movement } = play;
    currentCameraRef.current = cKey || null;

    const isLiveStream = !mKey;
    setIsLive(isLiveStream);

    // Initialize or reuse HLS
    if (Hls.isSupported()) {
      if (!hlsRef.current) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 90 });
        hlsRef.current = hls;
        hls.attachMedia(video);
        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
          onReady && onReady(video, hls);
          loadSource();
        });
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) {
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
            else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
            else { hls.destroy(); hlsRef.current = null; }
          }
        });
      } else {
        loadSource();
      }
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      onReady && onReady(video, null);
      loadSource();
    }

    function loadSource() {
      const video = videoRef.current;
      if (!video) return;
      const query = mKey && segments_prior_to_movement ? `?preseq=${segments_prior_to_movement}` : '';
      const src = `/video/${mKey ? `${mStartSegment}/${mSeconds}` : 'live'}/${cKey}/stream.m3u8${query}`;
      if (hlsRef.current) {
        hlsRef.current.loadSource(src);
      } else {
        video.src = src;
        video.load();
      }
      video.play().catch(() => {});
      updateOverlaySize();
    }

    // Detection polling for live streams
    if (isLiveStream && !detectTimerRef.current) {
      runDetection();
      detectTimerRef.current = setInterval(runDetection, DETECTOR_INTERVAL);
    } else if (!isLiveStream && detectTimerRef.current) {
      clearInterval(detectTimerRef.current);
      detectTimerRef.current = null;
      setBboxes([]);
    }

    const handleResize = () => updateOverlaySize();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [play, onReady, updateOverlaySize, runDetection]);

  // Scale bboxes to current video display size
  const renderBboxes = () => {
    if (!bboxes.length) return null;
    const video = videoRef.current;
    if (!video) return null;
    const rect = video.getBoundingClientRect();
    const vidW = video.videoWidth || 640;
    const vidH = video.videoHeight || 480;
    const sx = rect.width / vidW;
    const sy = rect.height / vidH;

    return bboxes.map((bbox, i) => {
      if (bbox.probability < MIN_PROB) return null;
      const [x1, y1, x2, y2] = bbox.box;
      const left = x1 * sx, top = y1 * sy;
      const w = (x2 - x1) * sx, h = (y2 - y1) * sy;
      const color = getColor(bbox.object);
      const label = bbox.object + ' ' + (bbox.probability * 100).toFixed(0) + '%';
      const labelW = Math.min(label.length * 6 + 6, w);

      return (
        <g key={i}>
          <rect x={left} y={top} width={w} height={h} fill="none" stroke={color} strokeWidth={2} />
          <rect x={left} y={Math.max(top - 16, 0)} width={labelW} height={16} fill={color} />
          <text x={left + 3} y={top - 3} fill="white" fontSize="10" fontFamily="sans-serif">{label}</text>
        </g>
      );
    });
  };

  const [isLive, setIsLive] = useState(false);

  if (imageUrl) {
    return (
      <div className="video-container">
        <img src={imageUrl} alt="Detection" style={{ display: 'block', height: '100vh', width: 'auto' }} />
      </div>
    );
  }

  return (
    <div className="video-container" style={{ position: 'relative' }}>
      <video
        ref={videoRef}
        controls autoPlay muted
        className={isLive ? 'live-stream' : ''}
        style={{ display: 'block', height: '100vh', maxHeight: 'calc((100vw - 350px) * 3 / 4)', width: 'auto', aspectRatio: '4/3', objectFit: 'contain' }}
        onLoadedMetadata={updateOverlaySize}
        onPlay={updateOverlaySize}
      />
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      <svg
        ref={overlayRef}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
      >
        {renderBboxes()}
      </svg>
      {isLive && (
        <div style={{
          position: 'absolute', top: 10, left: 10,
          background: 'rgba(255,0,0,0.8)', color: 'white',
          padding: '4px 8px', borderRadius: 4,
          fontSize: 12, fontWeight: 'bold', pointerEvents: 'none'
        }}>● LIVE</div>
      )}
    </div>
  );
}

function getColor(obj) {
  const map = {
    person: '#00FF00', car: '#0088FF', truck: '#FF8800', bus: '#FF8800',
    motorbike: '#00CCFF', bicycle: '#00CCFF', aeroplane: '#FF4444',
    train: '#AA44FF', boat: '#44AAFF', bird: '#FFFF00',
    cat: '#FF00FF', dog: '#FF00FF', horse: '#AA0000',
    sheep: '#AAAAAA', cow: '#884400',
  };
  return map[obj.toLowerCase()] || '#FFFF00';
}
