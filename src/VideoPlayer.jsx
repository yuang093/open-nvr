/**
 * VideoPlayer - Simple HLS video player compatible with App.jsx interface.
 * Replaces the original VideoJS component.
 */
import React, { useRef, useEffect, useState } from 'react';
import Hls from 'hls.js';

export function VideoPlayer({ onReady, play, imageUrl }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [isLive, setIsLive] = useState(false);

  // Handle play changes and HLS init combined
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

    function loadSrc() {
      const query = mKey && segments_prior_to_movement ? `?preseq=${segments_prior_to_movement}` : '';
      const src = `/video/${mKey ? `${mStartSegment}/${mSeconds}` : 'live'}/${cKey}/stream.m3u8${query}`;
      if (hlsRef.current) {
        hlsRef.current.loadSource(src);
      } else {
        video.src = src;
        video.load();
      }
      video.play().catch(() => {});
    }

    if (Hls.isSupported()) {
      if (!hlsRef.current) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 90 });
        hlsRef.current = hls;
        hls.attachMedia(video);
        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
          onReady && onReady(video, hls);
          loadSrc();
        });
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) {
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
            else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
            else { hls.destroy(); hlsRef.current = null; }
          }
        });
      } else {
        loadSrc();
      }
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      onReady && onReady(video, null);
      loadSrc();
    }
  }, [play, onReady]);

  if (imageUrl) {
    return (
      <div className="video-container">
        <img src={imageUrl} alt="Snapshot" style={{ display: 'block', height: '100vh', width: 'auto' }} />
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
      />
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
