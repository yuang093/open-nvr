/**
 * VideoPlayer - Simple HLS video player with live bbox overlay.
 */
import React, { useRef, useEffect, useState, useCallback } from 'react';
import Hls from 'hls.js';

const DETECT_INTERVAL_MS = 1000;

export function VideoPlayer({ onReady, play, imageUrl }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const canvasRef = useRef(null);
  const [isLive, setIsLive] = useState(false);
  const [bboxes, setBboxes] = useState([]);
  const [currentCamera, setCurrentCamera] = useState(null);
  const detectTimerRef = useRef(null);
  const lastDetectRef = useRef(0);

  // Capture frame and detect
  const captureAndDetect = useCallback(async (video, cameraKey) => {
    if (!video || !cameraKey) return;
    const now = Date.now();
    if (now - lastDetectRef.current < DETECT_INTERVAL_MS) return;
    lastDetectRef.current = now;

    try {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.5);

      const res = await fetch('/api/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cameraKey, image: dataUrl })
      });
      const result = await res.json();
      if (result.bboxes && result.bboxes.length > 0) {
        setBboxes(result.bboxes);
      } else {
        setBboxes([]);
      }
    } catch (e) {
      console.warn('Detection error:', e);
    }
  }, []);

  // Start/stop detection based on play state
  useEffect(() => {
    if (!play) {
      setBboxes([]);
      setCurrentCamera(null);
      if (detectTimerRef.current) {
        clearInterval(detectTimerRef.current);
        detectTimerRef.current = null;
      }
      return;
    }

    const cameraKey = play.cKey;
    setCurrentCamera(cameraKey);

    detectTimerRef.current = setInterval(() => {
      const video = videoRef.current;
      if (video && video.readyState >= 2) {
        captureAndDetect(video, cameraKey);
      }
    }, DETECT_INTERVAL_MS);

    return () => {
      if (detectTimerRef.current) {
        clearInterval(detectTimerRef.current);
        detectTimerRef.current = null;
      }
    };
  }, [play, captureAndDetect]);

  // Notify ready once video element is actually available
  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      const timer = setTimeout(() => {
        if (videoRef.current && onReady) {
          onReady(videoRef.current, null);
        }
      }, 100);
      return () => clearTimeout(timer);
    } else if (onReady) {
      onReady(video, null);
    }
  }, []);

  // Handle play changes and HLS init
  useEffect(() => {
    if (!play) {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      setIsLive(false);
      return;
    }

    const { cKey, mKey, mStartSegment, mSeconds, segments_prior_to_movement } = play;
    const video = videoRef.current;
    if (!video) return;

    const isLiveStream = !mKey;
    setIsLive(isLiveStream);

    function loadSrc(hls) {
      const query = mKey && segments_prior_to_movement ? `?preseq=${segments_prior_to_movement}` : '';
      const src = `/video/${mKey ? `${mStartSegment}/${mSeconds}` : 'live'}/${cKey}/stream.m3u8${query}`;
      if (hls) {
        hls.loadSource(src);
      } else {
        video.src = src;
        video.load();
      }
      video.play().catch(() => {});
    }

    // Always rebuild HLS instance to ensure clean camera switch
    // (hls.loadSource() alone does not reliably stop old streams)
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 90 });
      hlsRef.current = hls;
      hls.attachMedia(video);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        onReady && onReady(video, hls);
        loadSrc(hls);
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else { hls.destroy(); hlsRef.current = null; }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      onReady && onReady(video, null);
      loadSrc(null);
    }
  }, [play, onReady]);

  if (imageUrl) {
    return (
      <div className="video-container">
        <img src={imageUrl} alt="Snapshot" style={{ display: 'block', height: '100vh', width: 'auto' }} />
      </div>
    );
  }

  const videoWidth = videoRef.current?.videoWidth || 640;
  const videoHeight = videoRef.current?.videoHeight || 480;

  return (
    <div className="video-container" style={{ position: 'relative' }}>
      <video
        ref={videoRef}
        controls autoPlay muted
        className={isLive ? 'live-stream' : ''}
        style={{ display: 'block', height: '100vh', maxHeight: 'calc((100vw - 350px) * 3 / 4)', width: 'auto', aspectRatio: '4/3', objectFit: 'contain' }}
      />
      <svg
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        viewBox={`0 0 ${videoWidth} ${videoHeight}`}
      >
        {bboxes.map((bbox, i) => {
          const color = getColor(bbox.object);
          const label = `${(bbox.object || '').trim()} ${(bbox.probability * 100).toFixed(0)}%`;
          // Approximate label width: 16px per char at fontSize 32
          const labelW = label.length * 16 + 12;
          const labelH = 38;
          const labelY = Math.max(bbox.box[1] - labelH - 2, 0);
          return (
            <g key={i}>
              <rect
                x={bbox.box[0]}
                y={bbox.box[1]}
                width={bbox.box[2] - bbox.box[0]}
                height={bbox.box[3] - bbox.box[1]}
                fill="none"
                stroke={color}
                strokeWidth={4}
              />
              <rect
                x={bbox.box[0]}
                y={labelY}
                width={labelW}
                height={labelH}
                fill={color}
                stroke="black"
                strokeWidth={2}
                rx={4}
              />
              <text
                x={bbox.box[0] + 6}
                y={labelY + 28}
                fill="white"
                stroke="black"
                strokeWidth={1}
                paintOrder="stroke"
                fontSize={32}
                fontWeight="bold"
                fontFamily="sans-serif"
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>
      {isLive && (
        <div style={{
          position: 'absolute', top: 10, left: 10,
          background: 'rgba(255,0,0,0.8)', color: 'white',
          padding: '4px 8px', borderRadius: 4,
          fontSize: 12, fontWeight: 'bold', pointerEvents: 'none'
        }}>● LIVE</div>
      )}
      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  );
}

// Per-object color map for bbox outlines + label backgrounds.
// Mirrors COCO classes commonly seen on CCTV (person, vehicles, animals).
// Uses .trim() because some COCO class names have trailing spaces (motorbike, aeroplane, etc.)
function getColor(obj) {
  const map = {
    person: '#00FF00', car: '#0088FF', truck: '#FF8800', bus: '#FF8800',
    motorbike: '#00CCFF', bicycle: '#00CCFF', aeroplane: '#FF4444',
    train: '#AA44FF', boat: '#44AAFF', bird: '#FFFF00',
    cat: '#FF00FF', dog: '#FF00FF', horse: '#AA0000',
    sheep: '#AAAAAA', cow: '#884400',
  };
  const key = (obj || '').trim().toLowerCase();
  return map[key] || '#FFFF00';
}
