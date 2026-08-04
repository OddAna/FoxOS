import React, { useState } from 'react';
import { ZoomIn, ZoomOut, Maximize } from 'lucide-react';

const ImageViewerApp = ({ filePath }) => {
  const [scale, setScale] = useState(1);
  const [showToolbar, setShowToolbar] = useState(false);

  if (!filePath) return null;
  const imageUrl = `/api/static${filePath.split('/').map(encodeURIComponent).join('/')}`;
  const fileName = filePath.split('/').pop();

  return (
    <div 
      style={{ 
        position: 'relative',
        display: 'flex', 
        height: '100%', 
        width: '100%', 
        backgroundColor: '#000',
        overflow: 'hidden',
        justifyContent: 'center',
        alignItems: 'center'
      }}
      onMouseEnter={() => setShowToolbar(true)}
      onMouseLeave={() => setShowToolbar(false)}
    >
      {/* Blurred Background */}
      <div 
        style={{
          position: 'absolute',
          top: '-10%',
          left: '-10%',
          width: '120%',
          height: '120%',
          backgroundImage: `url(${imageUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          filter: 'blur(40px) brightness(0.6)',
          zIndex: 0
        }}
      />
      
      {/* Top Header */}
      <div style={{
        position: 'absolute',
        top: 0, left: 0, right: 0,
        height: '60px',
        background: 'linear-gradient(to bottom, rgba(0,0,0,0.7), transparent)',
        display: 'flex',
        alignItems: 'flex-start',
        padding: '12px 20px',
        color: 'rgba(255,255,255,0.9)',
        fontSize: '13px',
        fontWeight: '500',
        zIndex: 2,
        opacity: showToolbar ? 1 : 0,
        transition: 'opacity 0.3s ease'
      }}>
        {fileName}
      </div>

      {/* Main Image */}
      <img 
        src={imageUrl} 
        alt={fileName}
        style={{ 
          maxWidth: '90%', 
          maxHeight: '90%', 
          objectFit: 'contain',
          transform: `scale(${scale})`,
          transition: 'transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)',
          zIndex: 1,
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)'
        }} 
      />

      {/* Floating Toolbar */}
      <div style={{
        position: 'absolute',
        bottom: '30px',
        left: '50%',
        transform: `translateX(-50%) translateY(${showToolbar ? '0' : '20px'})`,
        opacity: showToolbar ? 1 : 0,
        transition: 'all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)',
        background: 'rgba(30,30,30,0.6)',
        backdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '16px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 16px',
        zIndex: 2,
        boxShadow: '0 10px 30px rgba(0,0,0,0.5)'
      }}>
        <div className="toolbar-btn" onClick={() => setScale(s => Math.min(s + 0.25, 3))} title="Yakınlaştır">
          <ZoomIn size={18} color="#fff" />
        </div>
        <div className="toolbar-btn" onClick={() => setScale(s => Math.max(s - 0.25, 0.5))} title="Uzaklaştır">
          <ZoomOut size={18} color="#fff" />
        </div>
        <div style={{ width: '1px', background: 'rgba(255,255,255,0.2)', margin: '0 4px', height: '20px' }} />
        <div className="toolbar-btn" onClick={() => setScale(1)} title="Gerçek Boyut">
          <Maximize size={18} color="#fff" />
        </div>
      </div>

      <style>{`
        .toolbar-btn {
          width: 32px;
          height: 32px;
          display: flex;
          justify-content: center;
          align-items: center;
          border-radius: 8px;
          cursor: pointer;
          transition: background 0.2s;
        }
        .toolbar-btn:hover {
          background: rgba(255,255,255,0.2);
        }
      `}</style>
    </div>
  );
};

export default ImageViewerApp;
