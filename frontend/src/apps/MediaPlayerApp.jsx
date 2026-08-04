import React, { useRef, useState, useEffect } from 'react';
import { Play, Pause, SkipForward, SkipBack, Music } from 'lucide-react';

const MediaPlayerApp = ({ filePath, ext }) => {
  const mediaPath = filePath || '';
  const mediaUrl = `/api/static${mediaPath.split('/').map(encodeURIComponent).join('/')}`;
  const fileName = mediaPath.split('/').pop().replace(ext || '', '');
  const isAudio = ['.mp3', '.wav', '.ogg'].includes(ext);
  
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState('0:00');
  const [duration, setDuration] = useState('0:00');

  useEffect(() => {
    if (filePath && isAudio && audioRef.current) {
      // Auto play on load
      audioRef.current.play().catch(e => console.log('Otoplay engellendi:', e));
      setIsPlaying(true);
    }
  }, [filePath, isAudio, mediaUrl]);

  if (!filePath) return null;

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const formatTime = (time) => {
    if (isNaN(time)) return '0:00';
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleTimeUpdate = () => {
    if (!audioRef.current) return;
    const current = audioRef.current.currentTime;
    const total = audioRef.current.duration;
    setCurrentTime(formatTime(current));
    setProgress((current / total) * 100);
  };

  const handleLoadedMetadata = () => {
    if (!audioRef.current) return;
    setDuration(formatTime(audioRef.current.duration));
  };

  const handleSeek = (e) => {
    if (!audioRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = x / rect.width;
    audioRef.current.currentTime = percent * audioRef.current.duration;
  };

  if (isAudio) {
    return (
      <div style={{ 
        display: 'flex', flexDirection: 'column', height: '100%', width: '100%', 
        background: 'linear-gradient(135deg, #1f1c2c 0%, #928DAB 100%)', 
        alignItems: 'center', padding: '24px', boxSizing: 'border-box'
      }}>
        {/* Cover Art Placeholder */}
        <div style={{
          width: '200px', height: '200px', borderRadius: '16px',
          background: 'rgba(255,255,255,0.1)', backdropFilter: 'blur(10px)',
          boxShadow: '0 20px 40px rgba(0,0,0,0.4)', display: 'flex',
          justifyContent: 'center', alignItems: 'center', marginBottom: '32px',
          border: '1px solid rgba(255,255,255,0.2)'
        }}>
          <Music size={80} color="rgba(255,255,255,0.6)" strokeWidth={1} />
        </div>

        {/* Track Info */}
        <div style={{ textAlign: 'center', marginBottom: '24px', width: '100%' }}>
          <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {fileName}
          </div>
          <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)', marginTop: '4px' }}>
            Bilinmeyen Sanatçı
          </div>
        </div>

        {/* Progress Bar */}
        <div style={{ width: '100%', marginBottom: '24px' }}>
          <div 
            style={{ width: '100%', height: '6px', background: 'rgba(0,0,0,0.3)', borderRadius: '3px', cursor: 'pointer', position: 'relative' }}
            onClick={handleSeek}
          >
            <div style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: `${progress}%`, background: '#fff', borderRadius: '3px' }}>
              <div style={{ position: 'absolute', right: '-4px', top: '-4px', width: '14px', height: '14px', background: '#fff', borderRadius: '50%', boxShadow: '0 2px 5px rgba(0,0,0,0.3)' }} />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'rgba(255,255,255,0.6)', marginTop: '8px' }}>
            <span>{currentTime}</span>
            <span>{duration}</span>
          </div>
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          <SkipBack size={24} color="#fff" style={{ cursor: 'pointer', opacity: 0.8 }} />
          <div 
            onClick={togglePlay}
            style={{ 
              width: '56px', height: '56px', borderRadius: '50%', background: '#fff', 
              display: 'flex', justifyContent: 'center', alignItems: 'center', cursor: 'pointer',
              boxShadow: '0 10px 20px rgba(0,0,0,0.2)'
            }}
          >
            {isPlaying ? <Pause size={24} color="#000" fill="#000" /> : <Play size={24} color="#000" fill="#000" style={{ marginLeft: '4px' }} />}
          </div>
          <SkipForward size={24} color="#fff" style={{ cursor: 'pointer', opacity: 0.8 }} />
        </div>

        <audio 
          ref={audioRef} 
          src={mediaUrl} 
          onTimeUpdate={handleTimeUpdate} 
          onLoadedMetadata={handleLoadedMetadata} 
          onEnded={() => setIsPlaying(false)}
        />
      </div>
    );
  }

  // VIDEO UI
  return (
    <div style={{ 
      display: 'flex', height: '100%', width: '100%', 
      backgroundColor: '#000', justifyContent: 'center', alignItems: 'center',
      position: 'relative'
    }}>
      <video 
        controls 
        src={mediaUrl} 
        style={{ width: '100%', height: '100%', objectFit: 'contain' }} 
        autoPlay 
      />
    </div>
  );
};

export default MediaPlayerApp;
