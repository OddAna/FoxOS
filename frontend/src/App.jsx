import React, { useState, useEffect, useRef } from 'react';
import './index.css';
import { WindowProvider, useWindowManager } from './contexts/WindowContext';
import { DialogProvider, useDialog } from './contexts/DialogContext';
import { getFileIcon } from './utils/fileIcons';
import TopBar from './components/TopBar';
import Dock from './components/Dock';
import Window from './components/Window';
import SettingsApp from './apps/SettingsApp';
import ServerApp from './apps/ServerApp';
import FilesApp from './apps/FilesApp';
import TextEditorApp from './apps/TextEditorApp';
import ImageViewerApp from './apps/ImageViewerApp';
import MediaPlayerApp from './apps/MediaPlayerApp';
import TerminalApp from './apps/TerminalApp';
import AppStoreApp from './apps/AppStoreApp';
import { useAuth } from './contexts/AuthContext';
import SetupScreen from './components/auth/SetupScreen';
import LockScreen from './components/auth/LockScreen';
import { apiFetch } from './api';

const Desktop = () => {
  const { windows, openWindow } = useWindowManager();
  const { showDialog } = useDialog();
  const [desktopMenu, setDesktopMenu] = useState(null);
  const [desktopFiles, setDesktopFiles] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [selectionBox, setSelectionBox] = useState(null);
  const gridRef = useRef(null);
  const fileRefs = useRef({});
  const isDraggingMarquee = useRef(false);

  const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight });

  const [positions, setPositions] = useState(() => {
    const saved = localStorage.getItem('desktop_positions_v3');
    return saved ? JSON.parse(saved) : {};
  });

  const getFilePosition = (file) => {
    const MARGIN_X = 20;
    const MARGIN_Y = 20;
    const TASKBAR_H = 80;
    const desktopW = windowSize.width;
    const desktopH = windowSize.height - 30;
    
    const availableW = desktopW - (2 * MARGIN_X);
    const availableH = desktopH - TASKBAR_H - (2 * MARGIN_Y);

    const maxCols = Math.max(1, Math.floor(availableW / 100));
    const maxRows = Math.max(1, Math.floor(availableH / 100));

    const cellW = availableW / maxCols;
    const cellH = availableH / maxRows;

    let col, row;
    if (positions[file.name] && positions[file.name].col !== undefined) {
      col = Math.min(positions[file.name].col, maxCols - 1);
      row = Math.min(positions[file.name].row, maxRows - 1);
    } else {
      const index = desktopFiles.findIndex(f => f.name === file.name);
      if (index === -1) { col = 0; row = 0; }
      else {
        col = Math.floor(index / maxRows);
        row = index % maxRows;
        if (col >= maxCols) col = maxCols - 1;
      }
    }

    return {
      left: MARGIN_X + (col * cellW),
      top: MARGIN_Y + (row * cellH),
      width: cellW,
      height: cellH
    };
  };

  const fetchDesktopFiles = async () => {
    try {
      const response = await apiFetch('/api/files?path=Masaüstü');
      const data = await response.json();
      const newFiles = data.items || [];
      
      setPositions(prev => {
        let updated = { ...prev };
        let changed = false;
        
        const occupied = new Set();
        Object.values(updated).forEach(pos => {
          if (pos.col !== undefined) occupied.add(`${pos.col},${pos.row}`);
        });
        
        const MARGIN_Y = 20;
        const TASKBAR_H = 80;
        const availableH = window.innerHeight - 30 - TASKBAR_H - (2 * MARGIN_Y);
        const maxRows = Math.max(1, Math.floor(availableH / 100));
        let nextIndex = 0;
        
        newFiles.forEach(file => {
          if (!updated[file.name] || updated[file.name].col === undefined) {
            let col, row;
            while (true) {
              col = Math.floor(nextIndex / maxRows);
              row = nextIndex % maxRows;
              if (!occupied.has(`${col},${row}`)) {
                break;
              }
              nextIndex++;
            }
            updated[file.name] = { col, row };
            occupied.add(`${col},${row}`);
            changed = true;
          }
        });
        
        if (changed) {
          localStorage.setItem('desktop_positions_v3', JSON.stringify(updated));
        }
        return updated;
      });

      setDesktopFiles(newFiles);
    } catch (err) {
      console.error('Masaüstü dosyaları çekilemedi:', err);
    }
  };

  useEffect(() => {
    fetchDesktopFiles();
    const handleRefresh = () => fetchDesktopFiles();
    const handleResize = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    
    window.addEventListener('refresh_files', handleRefresh);
    window.addEventListener('resize', handleResize);
    
    return () => {
      window.removeEventListener('refresh_files', handleRefresh);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    const closeMenu = () => setDesktopMenu(null);
    window.addEventListener('click', closeMenu);
    window.addEventListener('contextmenu', closeMenu, { capture: true });
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('contextmenu', closeMenu, { capture: true });
    };
  }, []);

  const handleContextMenu = (e, file = null) => {
    // Dock, pencere veya topbar içindeyken masaüstü menüsünü engelle
    if (!file && (e.target.closest('.window') || e.target.closest('.dock-container') || e.target.closest('.topbar'))) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    
    if (file && !selectedIds.includes(file.id)) {
      setSelectedIds([file.id]);
    } else if (!file && !e.target.closest('.desktop-file')) {
      setSelectedIds([]);
    }
    setDesktopMenu({ x: e.clientX, y: e.clientY, type: file ? 'file' : 'grid', file: file });
  };

  const handleDragStart = (e, file) => {
    const rect = e.target.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    let dragFilesData = [];
    if (selectedIds.includes(file.id) && selectedIds.length > 1) {
      const anchorPos = getFilePosition(file);
      dragFilesData = desktopFiles
        .filter(f => selectedIds.includes(f.id))
        .map(f => {
           const pos = getFilePosition(f);
           return {
             id: f.id,
             name: f.name,
             relX: pos.left - anchorPos.left,
             relY: pos.top - anchorPos.top
           };
        });
    } else {
      dragFilesData = [{ id: file.id, name: file.name, relX: 0, relY: 0 }];
    }

    e.dataTransfer.setData('text/plain', JSON.stringify({
      files: dragFilesData,
      sourcePath: 'Masaüstü',
      offsetX,
      offsetY
    }));
    e.dataTransfer.effectAllowed = 'move';
    
    // Custom drag image for multiple files
    if (dragFilesData.length > 1) {
      const dragContainer = document.createElement('div');
      dragContainer.style.position = 'absolute';
      dragContainer.style.top = '-9999px';
      dragContainer.style.left = '-9999px';
      
      let minX = 0, minY = 0;
      dragFilesData.forEach(f => {
        if (f.relX < minX) minX = f.relX;
        if (f.relY < minY) minY = f.relY;
      });

      dragFilesData.forEach(f => {
        const fileEl = fileRefs.current[f.id];
        if (fileEl) {
           const clone = fileEl.cloneNode(true);
           clone.style.position = 'absolute';
           clone.style.left = (f.relX - minX) + 'px';
           clone.style.top = (f.relY - minY) + 'px';
           clone.style.background = 'transparent';
           clone.style.border = 'none';
           clone.style.width = fileEl.offsetWidth + 'px';
           clone.style.height = fileEl.offsetHeight + 'px';
           dragContainer.appendChild(clone);
        }
      });
      
      document.body.appendChild(dragContainer);
      e.dataTransfer.setDragImage(dragContainer, offsetX - minX, offsetY - minY);
      setTimeout(() => document.body.removeChild(dragContainer), 0);
    } else {
      e.dataTransfer.setDragImage(e.target, offsetX, offsetY);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDesktopDrop = (e) => {
    e.preventDefault();
    const dataStr = e.dataTransfer.getData('text/plain');
    if (!dataStr) return;
    
    try {
      const data = JSON.parse(dataStr);
      // Tek dosyalı drag payload'larını da normalize et.
      const filesToMove = data.files || (data.name ? [{ name: data.name, relX: 0, relY: 0 }] : []);
      if (filesToMove.length === 0) return;

      const MARGIN_X = 20;
      const MARGIN_Y = 20;
      const TASKBAR_H = 80;

      const desktopRect = e.currentTarget.getBoundingClientRect();
      const availableW = desktopRect.width - (2 * MARGIN_X);
      const availableH = desktopRect.height - TASKBAR_H - (2 * MARGIN_Y);

      const maxCols = Math.max(1, Math.floor(availableW / 100));
      const maxRows = Math.max(1, Math.floor(availableH / 100));

      const cellW = availableW / maxCols;
      const cellH = availableH / maxRows;

      let rawX = (e.clientX - desktopRect.left) - data.offsetX;
      let rawY = (e.clientY - desktopRect.top) - data.offsetY;

      const col = Math.min(maxCols - 1, Math.max(0, Math.round((rawX - MARGIN_X) / cellW)));
      const row = Math.min(maxRows - 1, Math.max(0, Math.round((rawY - MARGIN_Y) / cellH)));

      if (data.sourcePath && data.sourcePath !== 'Masaüstü') {
        const promises = filesToMove.map(f => {
          const sourceFile = data.sourcePath === '/' ? `/${f.name}` : `${data.sourcePath}/${f.name}`;
          return apiFetch('/api/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourcePath: sourceFile, targetPath: '/Masaüstü' })
          });
        });

        Promise.all(promises).then(() => {
          window.dispatchEvent(new Event('refresh_files'));
        }).catch(err => {
          console.error("Taşıma hatası:", err);
          showDialog({ title: 'Hata', message: 'Dosyalar Masaüstüne taşınamadı.', type: 'error' });
        });
        return;
      }

      let anyCollision = false;
      filesToMove.forEach(f => {
        // Multi-file drag is rare for now, assuming relX/relY map roughly to col/row offsets
        const dCol = Math.round((f.relX || 0) / cellW);
        const dRow = Math.round((f.relY || 0) / cellH);
        const finalCol = Math.min(maxCols - 1, Math.max(0, col + dCol));
        const finalRow = Math.min(maxRows - 1, Math.max(0, row + dRow));
        
        const isOccupied = desktopFiles.some((existing) => {
          if (filesToMove.find(df => df.name === existing.name)) return false; 
          const existingPos = positions[existing.name] || {};
          return existingPos.col === finalCol && existingPos.row === finalRow;
        });
        if (isOccupied) anyCollision = true;
      });

      if (anyCollision) return; // İkonlardan biri bile dolu bir yere geliyorsa işlemi iptal et

      const newPositions = { ...positions };
      filesToMove.forEach(f => {
        const dCol = Math.round((f.relX || 0) / cellW);
        const dRow = Math.round((f.relY || 0) / cellH);
        const finalCol = Math.min(maxCols - 1, Math.max(0, col + dCol));
        const finalRow = Math.min(maxRows - 1, Math.max(0, row + dRow));
        
        newPositions[f.name] = { col: finalCol, row: finalRow };
      });
      
      setPositions(newPositions);
      localStorage.setItem('desktop_positions_v3', JSON.stringify(newPositions));
    } catch (err) {
      console.error("Sürükle bırak parse hatası:", err);
    }
  };

  const handleDesktopFolderDrop = (e, targetFolder) => {
    e.preventDefault();
    e.stopPropagation();
    const dataStr = e.dataTransfer.getData('text/plain');
    if (!dataStr) return;
    
    try {
      const data = JSON.parse(dataStr);
      const filesToMove = data.files || (data.name ? [{ name: data.name }] : []);
      if (filesToMove.length === 0) return;
      
      if (filesToMove.some(f => f.name === targetFolder.name)) return;
      
      const targetPath = `/Masaüstü/${targetFolder.name}`;
      
      const promises = filesToMove.map(f => {
        const srcPath = data.sourcePath;
        let sourceFile = srcPath === 'Masaüstü' ? `/Masaüstü/${f.name}` : `${srcPath === '/' ? '' : srcPath}/${f.name}`;
        
        if (sourceFile === `${targetPath}/${f.name}`) return Promise.resolve();

        return apiFetch('/api/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourcePath: sourceFile, targetPath: targetPath })
        });
      });

      Promise.all(promises).then(() => {
        window.dispatchEvent(new Event('refresh_files'));
      }).catch(() => {
        showDialog({ title: 'Hata', message: 'Dosyalar klasöre taşınamadı.', type: 'error' });
      });
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = (file) => {
    setDesktopMenu(null);
    showDialog({
      title: 'Dosyayı Sil',
      message: `"${file.name}" adlı öğeyi Çöp Kutusuna taşımak istediğinize emin misiniz?`,
      type: 'warning',
      confirmText: 'Evet, Sil',
      onConfirm: async () => {
        try {
          await apiFetch('/api/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: `/Masaüstü/${file.name}` })
          });
          fetchDesktopFiles();
        } catch {
          showDialog({ title: 'Hata', message: 'Dosya silinemedi.', type: 'error' });
        }
      }
    });
  };

  const handleRename = (file) => {
    setDesktopMenu(null);
    showDialog({
      title: 'Yeniden Adlandır',
      message: `"${file.name}" için yeni bir ad girin:`,
      type: 'prompt',
      defaultValue: file.name,
      confirmText: 'Kaydet',
      onConfirm: (newName) => {
        if (!newName || newName === file.name) return;
        apiFetch('/api/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: `/Masaüstü/${file.name}`, newName })
        }).then(() => fetchDesktopFiles())
          .catch(() => showDialog({ title: 'Hata', message: 'Yeniden adlandırılamadı.', type: 'error' }));
      }
    });
  };

  const handleNewFolder = () => {
    setDesktopMenu(null);
    showDialog({
      title: 'Yeni Klasör',
      message: 'Oluşturulacak klasörün adını girin:',
      type: 'prompt',
      defaultValue: 'Yeni Klasör',
      confirmText: 'Oluştur',
      onConfirm: (name) => {
        if (!name) return;
        apiFetch('/api/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/Masaüstü', name })
        }).then(() => fetchDesktopFiles())
          .catch(() => showDialog({ title: 'Hata', message: 'Klasör oluşturulamadı.', type: 'error' }));
      }
    });
  };

  const handleFileClick = (e, id) => {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
    } else {
      setSelectedIds([id]);
    }
    setDesktopMenu(null);
  };

  const handleFileDoubleClick = (file) => {
    const fullPath = `/Masaüstü/${file.name}`;
    
    if (file.type === 'folder') {
      openWindow({
        id: `folder-${file.id}`,
        type: 'files',
        title: file.name,
        component: null,
        initialPath: fullPath,
        width: 900,
        height: 600
      });
      return;
    }

    const ext = file.ext;
    let appType = 'text-viewer';
    let width = 600;
    let height = 500;
    let title = file.name;

    if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)) {
      appType = 'image-viewer';
      width = 700;
      height = 550;
    } else if (['.mp4', '.webm'].includes(ext)) {
      appType = 'media-player';
      width = 800;
      height = 500;
    } else if (['.mp3', '.wav', '.ogg'].includes(ext)) {
      appType = 'media-player';
      width = 320;
      height = 420;
    }

    openWindow({
      id: `viewer-${file.id}`,
      type: appType,
      title: title,
      filePath: fullPath,
      ext: ext,
      width: width,
      height: height
    });
  };

  const handleBackgroundClick = (e) => {
    if (isDraggingMarquee.current) {
      setTimeout(() => { isDraggingMarquee.current = false; }, 50);
      return;
    }
    if (!e.target.closest('.desktop-file')) {
      setSelectedIds([]);
    }
  };

  const startSelection = (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.window') || e.target.closest('.dock-container') || e.target.closest('.topbar') || e.target.closest('.desktop-file')) {
      return;
    }
    
    if (!e.ctrlKey && !e.metaKey) {
      setSelectedIds([]);
    }

    const rect = gridRef.current.getBoundingClientRect();
    const startX = e.clientX - rect.left;
    const startY = e.clientY - rect.top;

    let currentBox = { startX, startY, left: startX, top: startY, width: 0, height: 0 };
    setSelectionBox(currentBox);

    const initialSelectedIds = (e.ctrlKey || e.metaKey) ? [...selectedIds] : [];

    const onPointerMove = (moveEvent) => {
      if (!gridRef.current) return;
      isDraggingMarquee.current = true;
      const currentX = moveEvent.clientX - rect.left;
      const currentY = moveEvent.clientY - rect.top;
      
      currentBox = {
        startX, startY,
        left: Math.min(startX, currentX),
        top: Math.min(startY, currentY),
        width: Math.abs(currentX - startX),
        height: Math.abs(currentY - startY)
      };
      
      setSelectionBox(currentBox);

      const newSelectedIds = new Set(initialSelectedIds);
      Object.entries(fileRefs.current).forEach(([id, element]) => {
        if (!element) return;
        
        const elLeft = element.offsetLeft;
        const elTop = element.offsetTop;
        const elRight = elLeft + element.offsetWidth;
        const elBottom = elTop + element.offsetHeight;

        const boxRight = currentBox.left + currentBox.width;
        const boxBottom = currentBox.top + currentBox.height;

        const intersects = !(
          elRight < currentBox.left ||
          elLeft > boxRight ||
          elBottom < currentBox.top ||
          elTop > boxBottom
        );

        if (intersects) {
          newSelectedIds.add(id);
        } else if (!initialSelectedIds.includes(id)) {
          newSelectedIds.delete(id);
        }
      });
      
      setSelectedIds(Array.from(newSelectedIds));
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      setSelectionBox(null);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const renderApp = (win) => {
    switch (win.type) {
      case 'server': return <ServerApp />;
      case 'settings': return <SettingsApp />;
      case 'files': return <FilesApp initialPath={win.initialPath} />;
      case 'text-viewer': return <TextEditorApp filePath={win.filePath} />;
      case 'image-viewer': return <ImageViewerApp filePath={win.filePath} />;
      case 'media-player': return <MediaPlayerApp filePath={win.filePath} ext={win.ext} />;
      case 'terminal': return <TerminalApp />;
      case 'app-store': return <AppStoreApp />;
      default: return <div style={{ padding: 20, color: '#fff' }}>Bilinmeyen Uygulama: {win.title}</div>;
    }
  };

  return (
    <div 
      className="desktop" 
      onContextMenu={(e) => handleContextMenu(e, null)} 
      onClick={handleBackgroundClick}
      onDragOver={handleDragOver}
      onDrop={handleDesktopDrop}
    >
      <TopBar />
      
      {/* Masaüstü İkon Izgarası (Grid) */}
      <div 
        ref={gridRef}
        onPointerDown={startSelection}
        style={{
          position: 'absolute',
          top: '30px',
          left: '0',
          right: '0',
          bottom: '80px',
          padding: '10px',
          zIndex: 1,
          overflow: 'hidden'
      }}>
        {desktopFiles.map((file) => {
          const isSelected = selectedIds.includes(file.id);
          const pos = getFilePosition(file);

          return (
            <div
              key={file.id}
              className="desktop-file"
              ref={el => fileRefs.current[file.id] = el}
              draggable={true}
              onDragStart={(e) => handleDragStart(e, file)}
              onDragOver={file.type === 'folder' ? handleDragOver : undefined}
              onDrop={file.type === 'folder' ? (e) => handleDesktopFolderDrop(e, file) : undefined}
              onClick={(e) => handleFileClick(e, file.id)}
              onDoubleClick={() => handleFileDoubleClick(file)}
              onContextMenu={(e) => handleContextMenu(e, file)}
              style={{
                position: 'absolute',
                left: `${pos.left}px`,
                top: `${pos.top}px`,
                width: `${pos.width}px`,
                minHeight: `${pos.height}px`,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'flex-start',
                padding: '8px 4px',
                borderRadius: '8px',
                backgroundColor: isSelected ? 'rgba(255, 255, 255, 0.2)' : 'transparent',
                border: isSelected ? '1px solid rgba(255,255,255,0.4)' : '1px solid transparent',
                cursor: 'default',
                transition: 'background-color 0.1s',
                gap: '4px',
                userSelect: 'none'
              }}
            >
              {getFileIcon(file)}
              <span style={{
                color: '#fff',
                fontSize: '12px',
                textAlign: 'center',
                textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                width: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                lineHeight: '1.2'
              }}>
                {file.name}
              </span>
            </div>
          );
        })}

        {/* Marquee Selection Box */}
        {selectionBox && (
          <div style={{
            position: 'absolute',
            left: selectionBox.left,
            top: selectionBox.top,
            width: selectionBox.width,
            height: selectionBox.height,
            backgroundColor: 'rgba(14, 165, 233, 0.2)',
            border: '1px solid rgba(14, 165, 233, 0.6)',
            pointerEvents: 'none',
            zIndex: 100
          }} />
        )}
      </div>

      {/* Pencereler (Windows) alanı */}
      <div style={{ position: 'absolute', top: 30, left: 0, width: '100%', height: 'calc(100vh - 30px)', zIndex: 10, pointerEvents: 'none' }}>
        {windows.map(win => (
          <div key={win.id} style={{ pointerEvents: 'none', width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }}>
            <Window win={win}>
              {renderApp(win)}
            </Window>
          </div>
        ))}
      </div>
      
      <div style={{ position: 'absolute', bottom: 0, width: '100%', zIndex: 9999 }}>
        <Dock />
      </div>

      {/* Masaüstü Context Menu */}
      {desktopMenu && (
        <div 
          style={{
            position: 'fixed',
            left: desktopMenu.x,
            top: desktopMenu.y,
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
          onClick={(e) => { e.stopPropagation(); setDesktopMenu(null); }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          {desktopMenu.type === 'file' ? (
            <>
              <div className="context-item" onClick={() => handleFileDoubleClick(desktopMenu.file)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>Aç</div>
              <div className="context-item" onClick={() => handleRename(desktopMenu.file)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>Yeniden Adlandır</div>
              <div className="context-item" onClick={() => handleDelete(desktopMenu.file)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', color: '#ff5f56' }}>Sil</div>
            </>
          ) : (
            <>
              <div className="context-item" onClick={fetchDesktopFiles} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>Masaüstünü Yenile</div>
              <div className="context-item" onClick={handleNewFolder} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>Yeni Klasör</div>
              <div style={{ height: '1px', background: 'rgba(255,255,255,0.1)', margin: '4px 0' }}></div>
              <div className="context-item" style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>Duvar Kağıdını Değiştir</div>
              <div className="context-item" style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>Görüntü Ayarları</div>
            </>
          )}
        </div>
      )}
      
      <style>{`
        .context-item:hover { background: rgba(14, 165, 233, 0.8); color: white !important; }
      `}</style>
    </div>
  );
};

function App() {
  const { authState } = useAuth();

  if (authState === 'loading') return <div style={{ background: '#000', width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>Loading...</div>;
  if (authState === 'needs_setup') return <SetupScreen />;
  if (authState === 'locked') return <LockScreen />;

  return (
    <DialogProvider>
      <WindowProvider>
        <Desktop />
      </WindowProvider>
    </DialogProvider>
  );
}

export default App;
