import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { HardDrive, Download, Image as ImageIcon, FileText, Monitor, Trash2, ArrowLeft, ArrowUp, ArrowRight, RefreshCw, Grid, List, Search, ArrowDownAZ } from 'lucide-react';
import { useWindowManager } from '../contexts/WindowContext';
import { useDialog } from '../contexts/DialogContext';
import { getFileIcon } from '../utils/fileIcons';
import { apiFetch } from '../api';

const FilesApp = ({ initialPath = 'Masaüstü' }) => {
  const { showDialog } = useDialog();
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [typeSelectQuery, setTypeSelectQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [viewMode, setViewMode] = useState('grid');
  const [sortMode, setSortMode] = useState('name-asc');
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  
  const [history, setHistory] = useState([initialPath]);
  const [historyIndex, setHistoryIndex] = useState(0);

  const [selectedFileIds, setSelectedFileIds] = useState([]);
  const [selectionBox, setSelectionBox] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  
  const { openWindow } = useWindowManager();
  const containerRef = useRef(null);
  const gridRef = useRef(null);
  const fileRefs = useRef({});
  const searchTimeoutRef = useRef(null);
  const sortBtnRef = useRef(null);

  const sidebarItems = [
    { id: 'desktop', icon: <Monitor size={16} />, label: 'Masaüstü', path: 'Masaüstü' },
    { id: 'downloads', icon: <Download size={16} />, label: 'İndirilenler', path: 'İndirilenler' },
    { id: 'documents', icon: <FileText size={16} />, label: 'Belgeler', path: 'Belgeler' },
    { id: 'pictures', icon: <ImageIcon size={16} />, label: 'Resimler', path: 'Resimler' },
    { id: 'server', icon: <HardDrive size={16} />, label: 'Sunucu', path: 'Sunucu' },
    { id: 'trash', icon: <Trash2 size={16} color="#ffffff" />, label: 'Çöp Kutusu', path: 'Çöp Kutusu' },
  ];

  const fetchFiles = async () => {
    setLoading(true);
    setError(null);
    setSelectedFileIds([]);
    setContextMenu(null);
    try {
      const response = await apiFetch(`/api/files?path=${encodeURIComponent(currentPath)}`);
      const data = await response.json();
      setFiles(data.items || []);
    } catch (err) {
      console.error(err);
      setError('Sunucu bağlantı hatası veya dizin bulunamadı.');
      setFiles([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFiles();
    const handleRefresh = () => fetchFiles();
    window.addEventListener('refresh_files', handleRefresh);
    if (containerRef.current) {
      containerRef.current.focus();
    }
    return () => window.removeEventListener('refresh_files', handleRefresh);
  }, [currentPath]); // eslint-disable-line

  const navigateTo = (newPath) => {
    if (newPath === currentPath) return;
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newPath);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
    setCurrentPath(newPath);
  };

  const handleBack = () => {
    if (historyIndex > 0) {
      setHistoryIndex(historyIndex - 1);
      setCurrentPath(history[historyIndex - 1]);
    }
  };

  const handleForward = () => {
    if (historyIndex < history.length - 1) {
      setHistoryIndex(historyIndex + 1);
      setCurrentPath(history[historyIndex + 1]);
    }
  };

  const handleUp = () => {
    if (currentPath === '/') return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    navigateTo(parts.length > 0 ? parts.join('/') : '/');
  };

  // Click outside to close menus
  useEffect(() => {
    const closeMenus = (e) => {
      setContextMenu(null);
      if (sortBtnRef.current && !sortBtnRef.current.contains(e.target)) {
        setSortMenuOpen(false);
      }
    };
    window.addEventListener('click', closeMenus);
    window.addEventListener('contextmenu', closeMenus, { capture: true });
    return () => {
      window.removeEventListener('click', closeMenus);
      window.removeEventListener('contextmenu', closeMenus, { capture: true });
    };
  }, []);

  const handleDelete = (file) => {
    setContextMenu(null);
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
            body: JSON.stringify({ filePath: `${currentPath === '/' ? '' : currentPath}/${file.name}` })
          });
          fetchFiles();
        } catch {
          showDialog({ title: 'Hata', message: 'Dosya silinemedi.', type: 'error' });
        }
      }
    });
  };

  const handleRename = (file) => {
    setContextMenu(null);
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
          body: JSON.stringify({ filePath: `${currentPath === '/' ? '' : currentPath}/${file.name}`, newName })
        }).then(() => fetchFiles())
          .catch(() => showDialog({ title: 'Hata', message: 'Yeniden adlandırılamadı.', type: 'error' }));
      }
    });
  };

  const handleNewFolder = () => {
    setContextMenu(null);
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
          body: JSON.stringify({ path: currentPath, name })
        }).then(() => fetchFiles())
          .catch(() => showDialog({ title: 'Hata', message: 'Klasör oluşturulamadı.', type: 'error' }));
      }
    });
  };

  const handleSingleClick = (e, file) => {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      setSelectedFileIds(prev => 
        prev.includes(file.id) ? prev.filter(id => id !== file.id) : [...prev, file.id]
      );
    } else {
      setSelectedFileIds([file.id]);
    }
  };

  const handleDoubleClick = (e, file) => {
    e.stopPropagation();
    if (file.type === 'folder') {
      navigateTo(currentPath === '/' ? file.name : `${currentPath}/${file.name}`);
    } else {
      const fullPath = `/${currentPath}/${file.name}`;
      let appType = 'text-viewer';
      let title = file.name;
      let width = 600;
      let height = 500;
      const ext = file.ext;

      if (['.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(ext)) {
        appType = 'image-viewer';
        width = 800;
        height = 600;
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
    }
  };

  const handleContextMenu = (e, file = null) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (file && !selectedFileIds.includes(file.id)) {
      setSelectedFileIds([file.id]);
    } else if (!file) {
      setSelectedFileIds([]);
    }

    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      type: file ? 'file' : 'grid',
      file: file
    });
  };

  const startSelection = (e) => {
    // Sadece sol tık (0) ile seçime izin ver
    if (e.button !== 0) return;

    // Sadece gridin kendisine tıklanırsa çalışsın (dosyalara tıklanınca seçimi bozmasın)
    if (e.target !== gridRef.current) {
      if (e.target.closest('.file-item')) return;
    }
    
    if (!e.ctrlKey && !e.metaKey) {
      setSelectedFileIds([]);
    }

    const rect = gridRef.current.getBoundingClientRect();
    const startX = e.clientX - rect.left + gridRef.current.scrollLeft;
    const startY = e.clientY - rect.top + gridRef.current.scrollTop;

    let currentBox = { startX, startY, left: startX, top: startY, width: 0, height: 0 };
    setSelectionBox(currentBox);

    const initialSelectedIds = (e.ctrlKey || e.metaKey) ? [...selectedFileIds] : [];

    const onPointerMove = (moveEvent) => {
      if (!gridRef.current) return;
      const currentX = moveEvent.clientX - rect.left + gridRef.current.scrollLeft;
      const currentY = moveEvent.clientY - rect.top + gridRef.current.scrollTop;
      
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
        
        // Element'in grid içerisindeki koordinatlarını bul
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
      
      setSelectedFileIds(Array.from(newSelectedIds));
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      setSelectionBox(null);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const handleDragStart = (e, file) => {
    const rect = e.target.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    
    let dragFilesData = [];
    if (selectedFileIds.includes(file.id) && selectedFileIds.length > 1) {
      dragFilesData = files
        .filter(f => selectedFileIds.includes(f.id))
        .map(f => {
           const el = fileRefs.current[f.id];
           const elRect = el ? el.getBoundingClientRect() : rect;
           return {
             id: f.id,
             name: f.name,
             relX: elRect.left - rect.left,
             relY: elRect.top - rect.top
           };
        });
    } else {
      dragFilesData = [{ id: file.id, name: file.name, relX: 0, relY: 0 }];
    }

    e.dataTransfer.setData('text/plain', JSON.stringify({
      files: dragFilesData,
      sourcePath: currentPath,
      offsetX,
      offsetY
    }));
    e.dataTransfer.effectAllowed = 'move';
    
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
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const dataStr = e.dataTransfer.getData('text/plain');
    if (!dataStr) return;
    try {
      const data = JSON.parse(dataStr);
      const filesToMove = data.files || (data.name ? [{ name: data.name }] : []);
      if (filesToMove.length === 0) return;
      
      const srcPath = data.sourcePath;
      if (srcPath === currentPath) return; // Same directory
      
      const promises = filesToMove.map(f => {
        let sourceFile = srcPath === 'Masaüstü' ? `/Masaüstü/${f.name}` : `${srcPath === '/' ? '' : srcPath}/${f.name}`;
        return apiFetch('/api/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourcePath: sourceFile, targetPath: currentPath })
        });
      });

      Promise.all(promises).then(() => {
        window.dispatchEvent(new Event('refresh_files'));
      }).catch(() => {
        showDialog({ title: 'Hata', message: 'Dosyalar taşınamadı.', type: 'error' });
      });
    } catch (err) {
      console.error(err);
    }
  };

  const handleFolderDrop = (e, targetFolder) => {
    e.preventDefault();
    e.stopPropagation();
    const dataStr = e.dataTransfer.getData('text/plain');
    if (!dataStr) return;
    try {
      const data = JSON.parse(dataStr);
      const filesToMove = data.files || (data.name ? [{ name: data.name }] : []);
      if (filesToMove.length === 0) return;
      
      // Target folder can't be one of the dragged items
      if (filesToMove.some(f => f.name === targetFolder.name)) return;
      
      const srcPath = data.sourcePath;
      const targetPath = `${currentPath === '/' ? '' : currentPath}/${targetFolder.name}`;
      if (srcPath === targetPath) return;
      
      const promises = filesToMove.map(f => {
        let sourceFile = srcPath === 'Masaüstü' ? `/Masaüstü/${f.name}` : `${srcPath === '/' ? '' : srcPath}/${f.name}`;
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

  const handleKeyDown = (e) => {
    // Ignore if typing in search input
    if (e.target.tagName.toLowerCase() === 'input') return;
    
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const newQuery = typeSelectQuery + e.key.toLowerCase();
      setTypeSelectQuery(newQuery);
      
      const match = files.find(f => f.name.toLowerCase().startsWith(newQuery));
      if (match) {
        setSelectedFileIds([match.id]);
        const el = fileRefs.current[match.id];
        if (el && gridRef.current) {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
      
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = setTimeout(() => {
        setTypeSelectQuery('');
      }, 1000);
    }
  };

  const sortedFiles = [...files].sort((a, b) => {
    const isFolderA = a.type === 'folder';
    const isFolderB = b.type === 'folder';
    
    if (sortMode === 'type') {
      if (isFolderA && !isFolderB) return -1;
      if (!isFolderA && isFolderB) return 1;
      const extA = a.ext || '';
      const extB = b.ext || '';
      if (extA !== extB) return extA.localeCompare(extB);
      return a.name.localeCompare(b.name);
    }
    
    if (sortMode === 'name-desc') {
      if (isFolderA !== isFolderB) return isFolderA ? -1 : 1;
      return b.name.localeCompare(a.name);
    }
    
    // name-asc (default)
    if (sortMode === 'size') {
      if (isFolderA !== isFolderB) return isFolderA ? -1 : 1;
      return (b.size || 0) - (a.size || 0);
    }
    
    if (sortMode === 'date') {
      if (isFolderA !== isFolderB) return isFolderA ? -1 : 1;
      const dateA = a.mtime ? new Date(a.mtime).getTime() : 0;
      const dateB = b.mtime ? new Date(b.mtime).getTime() : 0;
      return dateB - dateA;
    }

    if (isFolderA !== isFolderB) return isFolderA ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const filteredFiles = sortedFiles.filter(f => f.name.toLowerCase().includes(searchInput.toLowerCase()));

  const formatSize = (bytes) => {
    if (bytes === 0 || !bytes) return '--';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '--';
    const d = new Date(dateStr);
    return d.toLocaleDateString('tr-TR') + ' ' + d.toLocaleTimeString('tr-TR', {hour: '2-digit', minute:'2-digit'});
  };

  return (
    <div 
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{ display: 'flex', height: '100%', width: '100%', color: '#fff', position: 'relative', outline: 'none' }}
    >
      {/* Sidebar */}
      <div style={{ width: '180px', background: 'rgba(0,0,0,0.3)', borderRight: '1px solid rgba(255,255,255,0.1)', padding: '16px 8px' }}>
        <div style={{ fontSize: '11px', color: '#ccc', fontWeight: 'bold', padding: '0 12px 8px', textTransform: 'uppercase' }}>Favoriler</div>
        {sidebarItems.map(item => {
          const isActive = currentPath === item.path || currentPath.startsWith(item.path + '/');
          return (
          <div 
            key={item.id}
            onClick={(e) => { e.stopPropagation(); navigateTo(item.path); }}
            style={{
              display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 12px', borderRadius: '6px',
              cursor: 'pointer', background: isActive ? 'rgba(255,255,255,0.15)' : 'transparent',
              marginBottom: '2px', fontSize: '13px'
            }}
          >
            {React.cloneElement(item.icon, { color: isActive ? '#fff' : '#0ea5e9' })}
            <span>{item.label}</span>
          </div>
        )})}
      </div>
      
      {/* Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Toolbar */}
        <div style={{ 
          height: '56px', borderBottom: '1px solid rgba(255,255,255,0.1)', 
          display: 'flex', alignItems: 'center', padding: '0 16px', gap: '16px', background: 'rgba(0,0,0,0.2)'
        }}>
          {/* Nav Buttons */}
          <div style={{ display: 'flex', gap: '4px' }}>
            <button 
              onClick={handleBack} 
              disabled={historyIndex === 0}
              style={{ background: 'transparent', border: 'none', color: historyIndex === 0 ? 'rgba(255,255,255,0.3)' : '#fff', cursor: historyIndex === 0 ? 'default' : 'pointer', padding: '6px', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <ArrowLeft size={18} />
            </button>
            <button 
              onClick={handleForward}
              disabled={historyIndex === history.length - 1}
              style={{ background: 'transparent', border: 'none', color: historyIndex === history.length - 1 ? 'rgba(255,255,255,0.3)' : '#fff', cursor: historyIndex === history.length - 1 ? 'default' : 'pointer', padding: '6px', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <ArrowRight size={18} />
            </button>
            <button 
              onClick={handleUp}
              disabled={currentPath === '/'}
              style={{ background: 'transparent', border: 'none', color: currentPath === '/' ? 'rgba(255,255,255,0.3)' : '#fff', cursor: currentPath === '/' ? 'default' : 'pointer', padding: '6px', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <ArrowUp size={18} />
            </button>
            <button 
              onClick={fetchFiles}
              style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', padding: '6px', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', marginLeft: '4px' }}
            >
              <RefreshCw size={16} />
            </button>
          </div>
          
          {/* Path Display */}
          <div style={{ 
            flex: 1, background: 'rgba(0,0,0,0.3)', borderRadius: '6px', padding: '6px 12px', 
            fontSize: '13px', display: 'flex', alignItems: 'center', border: '1px solid rgba(255,255,255,0.1)',
            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis'
          }}>
            {currentPath === 'Sunucu' ? 'Sunucu Ana Dizini' : currentPath.replace(/^Sunucu/, 'Sunucu Ana Dizini')}
            {selectedFileIds.length > 0 && <span style={{ marginLeft: '10px', color: '#0ea5e9' }}>({selectedFileIds.length} seçili)</span>}
          </div>
          
          {/* Search Box */}
          <div style={{
            position: 'relative', display: 'flex', alignItems: 'center', background: 'rgba(0,0,0,0.3)', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.1)', width: '160px'
          }}>
            <Search size={14} color="#ccc" style={{ margin: '0 8px' }} />
            <input 
              type="text" 
              placeholder="Ara..." 
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              style={{ background: 'transparent', border: 'none', color: '#fff', outline: 'none', width: '100%', padding: '6px 0', fontSize: '13px' }}
            />
          </div>
          
          {/* View Modes and Sorting */}
          <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            <div ref={sortBtnRef} style={{ position: 'relative' }}>
              <button 
                onClick={(e) => { e.stopPropagation(); setSortMenuOpen(!sortMenuOpen); }}
                style={{ background: sortMenuOpen ? 'rgba(255,255,255,0.15)' : 'transparent', border: 'none', color: '#fff', cursor: 'pointer', padding: '6px', borderRadius: '4px', display: 'flex' }}
                title="Sırala"
              >
                <ArrowDownAZ size={16} />
              </button>
              {sortMenuOpen && (
                <div style={{
                  position: 'absolute', top: '100%', right: '0', marginTop: '8px',
                  background: 'rgba(30, 30, 30, 0.95)', backdropFilter: 'blur(10px)',
                  border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px',
                  padding: '4px', minWidth: '150px', zIndex: 100,
                  boxShadow: '0 10px 30px rgba(0,0,0,0.5)', fontSize: '13px'
                }}>
                  <div className="context-item" onClick={() => { setSortMode('name-asc'); setSortMenuOpen(false); }} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', justifyContent: 'space-between' }}>
                    İsim (A-Z) {sortMode === 'name-asc' && '✓'}
                  </div>
                  <div className="context-item" onClick={() => { setSortMode('name-desc'); setSortMenuOpen(false); }} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', justifyContent: 'space-between' }}>
                    İsim (Z-A) {sortMode === 'name-desc' && '✓'}
                  </div>
                  <div className="context-item" onClick={() => { setSortMode('type'); setSortMenuOpen(false); }} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', justifyContent: 'space-between' }}>
                    Türüne Göre {sortMode === 'type' && '✓'}
                  </div>
                  <div className="context-item" onClick={() => { setSortMode('size'); setSortMenuOpen(false); }} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', justifyContent: 'space-between' }}>
                    Boyut (En Büyük) {sortMode === 'size' && '✓'}
                  </div>
                  <div className="context-item" onClick={() => { setSortMode('date'); setSortMenuOpen(false); }} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', justifyContent: 'space-between' }}>
                    Tarih (En Yeni) {sortMode === 'date' && '✓'}
                  </div>
                </div>
              )}
            </div>
            <div style={{ width: '1px', height: '16px', background: 'rgba(255,255,255,0.2)', margin: '0 4px' }} />
            <button 
              onClick={() => setViewMode('grid')}
              style={{ background: viewMode === 'grid' ? 'rgba(255,255,255,0.1)' : 'transparent', border: 'none', color: viewMode === 'grid' ? '#fff' : '#ccc', cursor: 'pointer', padding: '6px', borderRadius: '4px', display: 'flex' }}
              title="Izgara Görünümü"
            >
              <Grid size={16} />
            </button>
            <button 
              onClick={() => setViewMode('list')}
              style={{ background: viewMode === 'list' ? 'rgba(255,255,255,0.1)' : 'transparent', border: 'none', color: viewMode === 'list' ? '#fff' : '#ccc', cursor: 'pointer', padding: '6px', borderRadius: '4px', display: 'flex' }}
            >
              <List size={16} />
            </button>
          </div>
        </div>
        
        {/* File Container */}
        <div 
          ref={gridRef}
          onPointerDown={startSelection}
          onContextMenu={(e) => handleContextMenu(e, null)}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          style={{ 
            flex: 1, padding: '20px', display: 'flex', alignContent: 'flex-start',
            flexDirection: viewMode === 'list' ? 'column' : 'row',
            flexWrap: viewMode === 'list' ? 'nowrap' : 'wrap', 
            gap: viewMode === 'list' ? '4px' : '12px', 
            overflowY: 'auto', position: 'relative'
          }}
        >
          {loading && <div style={{ color: '#ccc', fontSize: '14px', width: '100%', textAlign: 'center' }}>Yükleniyor...</div>}
          {error && <div style={{ color: '#ff5f56', fontSize: '14px', width: '100%', textAlign: 'center' }}>{error}</div>}
          {!loading && !error && files.length === 0 && (
            <div style={{ color: '#ccc', fontSize: '14px', width: '100%', textAlign: 'center' }}>Klasör boş.</div>
          )}
          
          {!loading && !error && filteredFiles.length === 0 && searchInput.length > 0 && (
            <div style={{ color: '#ccc', fontSize: '14px', width: '100%', textAlign: 'center' }}>Arama sonucu bulunamadı.</div>
          )}
          
          {/* List View Header */}
          {!loading && !error && viewMode === 'list' && files.length > 0 && (
            <div style={{ display: 'flex', width: '100%', padding: '0 12px 8px 12px', borderBottom: '1px solid rgba(255,255,255,0.1)', color: '#ccc', fontSize: '12px', fontWeight: 'bold' }}>
              <span style={{ flex: 1, paddingLeft: '32px' }}>Ad</span>
              <div style={{ display: 'flex', minWidth: '280px', textAlign: 'left' }}>
                <span style={{ width: '100px' }}>Tür</span>
                <span style={{ width: '60px', textAlign: 'right' }}>Boyut</span>
                <span style={{ width: '120px', textAlign: 'right' }}>Değiştirilme Tarihi</span>
              </div>
            </div>
          )}
          
          {/* Files */}
          {!loading && !error && filteredFiles.map(file => {
            const isSelected = selectedFileIds.includes(file.id);
            return (
              <div 
                key={file.id} 
                className="file-item"
                ref={el => fileRefs.current[file.id] = el}
                draggable={true}
                onDragStart={(e) => handleDragStart(e, file)}
                onDragOver={file.type === 'folder' ? handleDragOver : undefined}
                onDrop={file.type === 'folder' ? (e) => handleFolderDrop(e, file) : undefined}
                onClick={(e) => handleSingleClick(e, file)}
                onDoubleClick={(e) => handleDoubleClick(e, file)}
                onContextMenu={(e) => handleContextMenu(e, file)}
                style={{ 
                  display: 'flex', 
                  flexDirection: viewMode === 'list' ? 'row' : 'column', 
                  alignItems: 'center', 
                  justifyContent: 'flex-start',
                  width: viewMode === 'list' ? '100%' : '90px', 
                  height: viewMode === 'list' ? '40px' : '110px',
                  cursor: 'pointer', 
                  gap: viewMode === 'list' ? '12px' : '8px', 
                  padding: viewMode === 'list' ? '4px 12px' : '10px 6px', 
                  borderRadius: '8px',
                  background: isSelected ? 'rgba(255, 255, 255, 0.2)' : 'transparent',
                  border: isSelected ? '1px solid rgba(255, 255, 255, 0.3)' : '1px solid transparent',
                  userSelect: 'none'
                }}
              >
                {/* Scale icon down if list mode */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: viewMode === 'list' ? '24px' : 'auto', height: viewMode === 'list' ? '24px' : 'auto' }}>
                  {React.cloneElement(getFileIcon(file), { size: viewMode === 'list' ? 24 : 48 })}
                </div>
                <span style={{ 
                  fontSize: '13px', 
                  textAlign: viewMode === 'list' ? 'left' : 'center', 
                  wordBreak: viewMode === 'list' ? 'normal' : 'break-word', 
                  whiteSpace: viewMode === 'list' ? 'nowrap' : 'normal',
                  textShadow: '0 1px 2px rgba(0,0,0,0.5)', 
                  padding: viewMode === 'list' ? '0' : '2px 6px', 
                  borderRadius: '4px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: viewMode === 'list' ? 'block' : '-webkit-box',
                  WebkitLineClamp: viewMode === 'list' ? undefined : 2,
                  WebkitBoxOrient: viewMode === 'list' ? undefined : 'vertical',
                  lineHeight: '1.2',
                  width: viewMode === 'list' ? 'auto' : '100%',
                  flex: viewMode === 'list' ? 1 : 'none'
                }}>
                  {file.name}
                </span>
                
                {viewMode === 'list' && (
                  <div style={{ display: 'flex', minWidth: '280px', color: '#ccc', fontSize: '12px', textAlign: 'left', alignItems: 'center' }}>
                    <span style={{ width: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.type === 'folder' ? 'Klasör' : file.ext?.toUpperCase().replace('.', '') || 'Dosya'}</span>
                    <span style={{ width: '60px', textAlign: 'right' }}>{file.type === 'folder' ? '--' : formatSize(file.size)}</span>
                    <span style={{ width: '120px', textAlign: 'right' }}>{formatDate(file.mtime)}</span>
                  </div>
                )}
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
      </div>

      {/* Context Menu (Portaled to body to escape backdrop-filter constraints) */}
      {contextMenu && createPortal(
        <div 
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            background: 'rgba(30, 30, 30, 0.8)',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '8px',
            padding: '4px',
            minWidth: '160px',
            zIndex: 999999,
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            fontSize: '13px'
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          {contextMenu.type === 'file' ? (
            <>
              <div className="context-item" onClick={(e) => { handleDoubleClick(e, contextMenu.file); setContextMenu(null); }} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>Aç</div>
              <div className="context-item" onClick={() => handleRename(contextMenu.file)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>Yeniden Adlandır</div>
              <div className="context-item" onClick={() => handleDelete(contextMenu.file)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', color: '#ff5f56' }}>Sil</div>
            </>
          ) : (
            <>
              <div className="context-item" onClick={handleNewFolder} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>Yeni Klasör</div>
              <div className="context-item" onClick={fetchFiles} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>Yenile</div>
            </>
          )}
        </div>,
        document.body
      )}
      
      {/* Basic hover styles for context menu items */}
      <style>{`
        .context-item:hover { background: rgba(14, 165, 233, 0.8); color: white !important; }
      `}</style>
    </div>
  );
};

export default FilesApp;
