import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useWindowManager } from '../contexts/WindowContext';

const Window = ({ win, children }) => {
  const { closeWindow, minimizeWindow, maximizeWindow, focusWindow, updateWindowPosition, updateWindowDimensions, focusedWindowId } = useWindowManager();
  const isFocused = focusedWindowId === win.id;
  const [contextMenu, setContextMenu] = useState(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const isMobileWindow = viewportWidth <= 720;

  useEffect(() => {
    const closeContextMenu = () => setContextMenu(null);
    window.addEventListener('click', closeContextMenu);
    window.addEventListener('contextmenu', closeContextMenu, { capture: true });
    return () => {
      window.removeEventListener('click', closeContextMenu);
      window.removeEventListener('contextmenu', closeContextMenu, { capture: true });
    };
  }, []);

  useEffect(() => {
    const updateViewport = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', updateViewport);
    window.addEventListener('orientationchange', updateViewport);
    return () => {
      window.removeEventListener('resize', updateViewport);
      window.removeEventListener('orientationchange', updateViewport);
    };
  }, []);

  const handleContextMenu = (event) => {
    if (event.target.closest('[data-foxos-context-menu]')) return;
    event.preventDefault();
    event.stopPropagation();
    focusWindow(win.id);
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 190)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 120))
    });
  };

  const runContextAction = (action) => {
    setContextMenu(null);
    action(win.id);
  };

  const handlePointerDown = (e) => {
    if (e.target.closest('.window-controls')) return;
    if (win.isMaximized || isMobileWindow) return;

    focusWindow(win.id);
    const startX = e.clientX;
    const startY = e.clientY;
    const initialX = win.x;
    const initialY = win.y;

    document.body.style.userSelect = 'none';

    const onPointerMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      updateWindowPosition(win.id, initialX + dx, initialY + dy);
    };

    const onPointerUp = () => {
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const handleResizePointerDown = (e, direction) => {
    e.stopPropagation();
    if (win.isMaximized || isMobileWindow) return;
    
    focusWindow(win.id);
    const startX = e.clientX;
    const startY = e.clientY;
    const initialX = win.x;
    const initialY = win.y;
    const initialWidth = win.width;
    const initialHeight = win.height;
    const minWidth = 300;
    const minHeight = 200;

    document.body.style.userSelect = 'none';

    const onPointerMove = (moveEvent) => {
      let newX = initialX;
      let newY = initialY;
      let newWidth = initialWidth;
      let newHeight = initialHeight;

      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      if (direction.includes('e')) {
        newWidth = Math.max(minWidth, initialWidth + dx);
      }
      if (direction.includes('s')) {
        newHeight = Math.max(minHeight, initialHeight + dy);
      }
      if (direction.includes('w')) {
        newWidth = Math.max(minWidth, initialWidth - dx);
        newX = initialX + (initialWidth - newWidth);
      }
      if (direction.includes('n')) {
        newHeight = Math.max(minHeight, initialHeight - dy);
        newY = initialY + (initialHeight - newHeight);
      }

      updateWindowDimensions(win.id, newX, newY, newWidth, newHeight);
    };

    const onPointerUp = () => {
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const style = {
    position: 'absolute',
    left: win.isMaximized || isMobileWindow ? 0 : win.x,
    top: win.isMaximized || isMobileWindow ? 0 : win.y,
    width: win.isMaximized || isMobileWindow ? '100%' : win.width,
    height: isMobileWindow ? '100%' : win.isMaximized ? 'calc(100vh - 30px - 85px)' : win.height, // 30px topbar, 85px for dock
    zIndex: win.zIndex,
    display: win.isMinimized ? 'none' : 'flex',
    flexDirection: 'column',
    borderRadius: win.isMaximized || isMobileWindow ? '0' : '12px',
    overflow: 'hidden',
    boxShadow: isFocused ? '0 20px 50px rgba(0,0,0,0.5)' : '0 10px 30px rgba(0,0,0,0.3)',
    transition: win.isMaximized && !isMobileWindow ? 'width 0.3s, height 0.3s, left 0.3s, top 0.3s, border-radius 0.3s' : 'none',
    pointerEvents: 'auto'
  };

  return (
    <>
    <div
      className={`window glass ${isFocused ? 'focused' : ''}`}
      style={style}
      onPointerDown={() => { if (!isFocused) focusWindow(win.id); }}
      onContextMenu={handleContextMenu}
    >
      <div 
        className="window-header" 
        onPointerDown={handlePointerDown}
        style={{
        height: '38px',
        background: 'rgba(255,255,255,0.05)',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        userSelect: 'none',
        position: 'relative'
      }}>
        <div className="window-controls" style={{ display: 'flex', gap: '8px', zIndex: 10 }}>
          <button type="button" className="window-control" aria-label="Pencereyi kapat" title="Kapat" onClick={() => closeWindow(win.id)} style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#ff5f56', cursor: 'pointer' }} />
          <button type="button" className="window-control" aria-label="Pencereyi simge durumuna küçült" title="Simge Durumuna Küçült" onClick={() => minimizeWindow(win.id)} style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#ffbd2e', cursor: 'pointer' }} />
          <button type="button" className="window-control" aria-label={win.isMaximized ? 'Pencereyi önceki boyutuna döndür' : 'Pencereyi tam ekran yap'} title={win.isMaximized ? 'Önceki Boyut' : 'Tam Ekran'} onClick={() => maximizeWindow(win.id)} style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#27c93f', cursor: 'pointer' }} />
        </div>
        <div className="window-title" style={{ position: 'absolute', width: '100%', textAlign: 'center', fontWeight: '500', fontSize: '13px', color: isFocused ? '#fff' : '#aaa' }}>
          {win.title}
        </div>
      </div>
      <div className="window-content" style={{ flex: 1, overflow: 'auto', background: 'rgba(0,0,0,0.2)' }}>
        {children || win.component}
      </div>

      {/* Resize Handles */}
      {!win.isMaximized && !isMobileWindow && (
        <>
          <div onPointerDown={(e) => handleResizePointerDown(e, 'n')} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '6px', cursor: 'ns-resize', zIndex: 100 }} />
          <div onPointerDown={(e) => handleResizePointerDown(e, 's')} style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '6px', cursor: 'ns-resize', zIndex: 100 }} />
          <div onPointerDown={(e) => handleResizePointerDown(e, 'e')} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: '6px', cursor: 'ew-resize', zIndex: 100 }} />
          <div onPointerDown={(e) => handleResizePointerDown(e, 'w')} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: '6px', cursor: 'ew-resize', zIndex: 100 }} />
          
          <div onPointerDown={(e) => handleResizePointerDown(e, 'nw')} style={{ position: 'absolute', top: 0, left: 0, width: '12px', height: '12px', cursor: 'nwse-resize', zIndex: 101 }} />
          <div onPointerDown={(e) => handleResizePointerDown(e, 'ne')} style={{ position: 'absolute', top: 0, right: 0, width: '12px', height: '12px', cursor: 'nesw-resize', zIndex: 101 }} />
          <div onPointerDown={(e) => handleResizePointerDown(e, 'sw')} style={{ position: 'absolute', bottom: 0, left: 0, width: '12px', height: '12px', cursor: 'nesw-resize', zIndex: 101 }} />
          <div onPointerDown={(e) => handleResizePointerDown(e, 'se')} style={{ position: 'absolute', bottom: 0, right: 0, width: '12px', height: '12px', cursor: 'nwse-resize', zIndex: 101 }} />
        </>
      )}
    </div>
    {contextMenu && createPortal(
      <div
        data-foxos-context-menu
        style={{
          position: 'fixed',
          left: contextMenu.x,
          top: contextMenu.y,
          background: 'rgba(30, 30, 30, 0.8)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '8px',
          padding: '4px',
          minWidth: '180px',
          zIndex: 999999,
          boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
          fontSize: '13px',
          color: '#fff'
        }}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      >
        <div className="context-item" onClick={() => runContextAction(minimizeWindow)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>Simge Durumuna Küçült</div>
        <div className="context-item" onClick={() => runContextAction(maximizeWindow)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>{win.isMaximized ? 'Önceki Boyut' : 'Tam Ekran'}</div>
        <div style={{ height: '1px', background: 'rgba(255,255,255,0.1)', margin: '4px 0' }} />
        <div className="context-item" onClick={() => runContextAction(closeWindow)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>Kapat</div>
      </div>,
      document.body
    )}
    </>
  );
};

export default Window;
