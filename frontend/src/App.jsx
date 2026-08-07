import React, { useState, useEffect, useRef } from 'react';
import { Play, RotateCw, Settings as SettingsIcon, Square, X } from 'lucide-react';
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
import ApplicationLogo from './components/ApplicationLogo';
import { APPLICATION_STATUS, applicationOperationalState } from './utils/applicationStatus';
import {
  DESKTOP_ROOT,
  applicationShortcutPath,
  canonicalDesktopPath,
  folderApplicationOperationalState
} from './utils/desktopShortcuts';
import { ApplicationProvider, useApplicationInventory } from './contexts/ApplicationContext';
import { useAuth } from './contexts/AuthContext';
import SetupScreen from './components/auth/SetupScreen';
import LockScreen from './components/auth/LockScreen';
import { apiFetch } from './api';
import {
  applyApplicationUpdate,
  checkAndPlanApplicationUpdate,
  updateConfirmationMessage
} from './utils/applicationUpdates';

const Desktop = () => {
  const { windows, openWindow } = useWindowManager();
  const { showDialog } = useDialog();
  const {
    actions: applicationActions,
    applications,
    refreshApplications,
    runApplicationAction: executeApplicationAction,
    setDesktopShortcut,
    setDesktopShortcutLocation
  } = useApplicationInventory();
  const visibleDesktopApplications = applications.filter((application) => application.desktopShortcutVisible !== false);
  const desktopApplications = visibleDesktopApplications.filter((application) => (
    applicationShortcutPath(application) === DESKTOP_ROOT
  ));
  const [desktopMenu, setDesktopMenu] = useState(null);
  const [desktopFiles, setDesktopFiles] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [selectionBox, setSelectionBox] = useState(null);
  const gridRef = useRef(null);
  const fileRefs = useRef({});
  const isDraggingMarquee = useRef(false);

  const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight });

  const [positions, setPositions] = useState(() => {
    try {
      const saved = localStorage.getItem('desktop_positions_v3');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const desktopItems = [
    ...desktopFiles.map((file) => ({
      ...file,
      desktopKind: 'file',
      desktopId: `file:${file.id}`,
      positionKey: file.name,
      file
    })),
    ...desktopApplications.map((application) => ({
      ...application,
      desktopKind: 'application',
      desktopId: `application:${application.id}`,
      positionKey: `application:${application.id}`,
      application
    }))
  ];

  const persistNewItemPositions = (items) => {
    setPositions((current) => {
      const updated = { ...current };
      const occupied = new Set();
      Object.values(updated).forEach((position) => {
        if (position.col !== undefined) occupied.add(`${position.col},${position.row}`);
      });

      const availableHeight = window.innerHeight - 30 - 80 - 40;
      const maxRows = Math.max(1, Math.floor(availableHeight / 100));
      let nextIndex = 0;
      let changed = false;

      items.forEach((item) => {
        if (updated[item.positionKey] && updated[item.positionKey].col !== undefined) return;
        let col;
        let row;
        do {
          col = Math.floor(nextIndex / maxRows);
          row = nextIndex % maxRows;
          nextIndex += 1;
        } while (occupied.has(`${col},${row}`));
        updated[item.positionKey] = { col, row };
        occupied.add(`${col},${row}`);
        changed = true;
      });

      if (changed) localStorage.setItem('desktop_positions_v3', JSON.stringify(updated));
      return updated;
    });
  };

  const getDesktopItemPosition = (item) => {
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
    if (positions[item.positionKey] && positions[item.positionKey].col !== undefined) {
      col = Math.min(positions[item.positionKey].col, maxCols - 1);
      row = Math.min(positions[item.positionKey].row, maxRows - 1);
    } else {
      const index = desktopItems.findIndex((candidate) => candidate.desktopId === item.desktopId);
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
      setDesktopFiles(newFiles);
      persistNewItemPositions(newFiles.map((file) => ({ positionKey: file.name })));
    } catch (err) {
      console.error('Masaüstü dosyaları çekilemedi:', err);
    }
  };

  const refreshDesktop = () => {
    fetchDesktopFiles();
    refreshApplications({ quiet: true }).catch((error) => {
      console.error('Sunucu uygulamaları çekilemedi:', error);
    });
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
    persistNewItemPositions(desktopApplications.map((application) => ({
      positionKey: `application:${application.id}`
    })));
  }, [desktopApplications]);

  useEffect(() => {
    const closeMenu = () => setDesktopMenu(null);
    window.addEventListener('click', closeMenu);
    window.addEventListener('contextmenu', closeMenu, { capture: true });
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('contextmenu', closeMenu, { capture: true });
    };
  }, []);

  const handleContextMenu = (e, item = null) => {
    // Dock, pencere veya topbar içindeyken masaüstü menüsünü engelle
    if (!item && (e.target.closest('.window') || e.target.closest('.dock-container') || e.target.closest('.topbar'))) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    
    if (item && !selectedIds.includes(item.desktopId)) {
      setSelectedIds([item.desktopId]);
    } else if (!item && !e.target.closest('.desktop-file')) {
      setSelectedIds([]);
    }
    setDesktopMenu({ x: e.clientX, y: e.clientY, type: item ? item.desktopKind : 'grid', item });
  };

  const handleDragStart = (e, item) => {
    const dragElement = fileRefs.current[item.desktopId] || e.currentTarget;
    const rect = dragElement.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    let draggedItems = [];
    if (selectedIds.includes(item.desktopId) && selectedIds.length > 1) {
      const anchorPos = getDesktopItemPosition(item);
      draggedItems = desktopItems
        .filter((candidate) => selectedIds.includes(candidate.desktopId))
        .map((candidate) => {
           const pos = getDesktopItemPosition(candidate);
           return {
             id: candidate.desktopId,
             name: candidate.name,
             positionKey: candidate.positionKey,
             desktopKind: candidate.desktopKind,
             applicationId: candidate.desktopKind === 'application' ? candidate.application.id : null,
             relX: pos.left - anchorPos.left,
             relY: pos.top - anchorPos.top
           };
        });
    } else {
      draggedItems = [{
        id: item.desktopId,
        name: item.name,
        positionKey: item.positionKey,
        desktopKind: item.desktopKind,
        applicationId: item.desktopKind === 'application' ? item.application.id : null,
        relX: 0,
        relY: 0
      }];
    }

    e.dataTransfer.setData('text/plain', JSON.stringify({
      files: draggedItems,
      sourcePath: 'Masaüstü',
      offsetX,
      offsetY
    }));
    e.dataTransfer.effectAllowed = 'move';
    
    // Custom drag image for multiple files
    if (draggedItems.length > 1) {
      const dragContainer = document.createElement('div');
      dragContainer.style.position = 'absolute';
      dragContainer.style.top = '-9999px';
      dragContainer.style.left = '-9999px';
      
      let minX = 0, minY = 0;
      draggedItems.forEach(f => {
        if (f.relX < minX) minX = f.relX;
        if (f.relY < minY) minY = f.relY;
      });

      draggedItems.forEach(f => {
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
      e.dataTransfer.setDragImage(dragElement, offsetX, offsetY);
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
      const filesToMove = data.files || (data.name ? [{
        name: data.name,
        positionKey: data.name,
        desktopKind: 'file',
        relX: 0,
        relY: 0
      }] : []);
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
        const movesFilesystemItems = filesToMove.some((file) => file.desktopKind !== 'application');
        const promises = filesToMove.map(f => {
          if (f.desktopKind === 'application' && f.applicationId) {
            const application = applications.find((candidate) => candidate.id === f.applicationId);
            return application
              ? setDesktopShortcutLocation(application, DESKTOP_ROOT)
              : Promise.reject(new Error('Uygulama artık sunucuda bulunamıyor'));
          }
          const sourceFile = data.sourcePath === '/' ? `/${f.name}` : `${data.sourcePath}/${f.name}`;
          return apiFetch('/api/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourcePath: sourceFile, targetPath: '/Masaüstü' })
          });
        });

        Promise.all(promises).then(() => {
          if (movesFilesystemItems) {
            window.dispatchEvent(new Event('refresh_files'));
            refreshApplications({ quiet: true }).catch(() => {});
          }
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
        
        const isOccupied = desktopItems.some((existing) => {
          if (filesToMove.find((dragged) => (
            (dragged.positionKey || dragged.name) === existing.positionKey
          ))) return false;
          const existingPos = positions[existing.positionKey] || {};
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
        
        newPositions[f.positionKey || f.name] = { col: finalCol, row: finalRow };
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
      
      if (filesToMove.some(f => f.desktopKind !== 'application' && f.name === targetFolder.name)) return;
      
      const targetPath = canonicalDesktopPath(`/Masaüstü/${targetFolder.name}`);
      const movesFilesystemItems = filesToMove.some((file) => file.desktopKind !== 'application');
      
      const promises = filesToMove.map(f => {
        if (f.desktopKind === 'application' && f.applicationId) {
          const application = applications.find((candidate) => candidate.id === f.applicationId);
          return application
            ? setDesktopShortcutLocation(application, targetPath)
            : Promise.reject(new Error('Uygulama artık sunucuda bulunamıyor'));
        }
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
        if (movesFilesystemItems) {
          window.dispatchEvent(new Event('refresh_files'));
          refreshApplications({ quiet: true }).catch(() => {});
        }
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
          refreshApplications({ quiet: true }).catch(() => {});
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
        }).then(() => {
          fetchDesktopFiles();
          refreshApplications({ quiet: true }).catch(() => {});
        })
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

  const handleDesktopItemClick = (e, id) => {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
    } else {
      setSelectedIds([id]);
    }
    setDesktopMenu(null);
  };

  const handleOpenApplication = (application) => {
    if (application.runtime.operationalState !== 'running') {
      showDialog({
        title: 'Servis Kapalı',
        message: 'Bu uygulama şu anda kapalı. Sağ tıklayarak servisi başlatabilirsiniz.',
        type: 'warning'
      });
      return;
    }
    if (application.externalUrl) {
      window.open(application.externalUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    if (!application.hostPort) {
      showDialog({
        title: 'Erişim Adresi Bulunamadı',
        message: 'Bu uygulama için açılabilir bir alan adı veya yayın portu bulunamadı.',
        type: 'info'
      });
      return;
    }

    const localFoxOS = ['127.0.0.1', 'localhost'].includes(window.location.hostname);
    if (application.bindAddress === '127.0.0.1' && !localFoxOS) {
      showDialog({
        title: 'Özel Erişim',
        message: `Bu uygulama 127.0.0.1:${application.hostPort} üzerinde çalışıyor. Aynı portu SSH tüneliyle açın.`,
        type: 'info'
      });
      return;
    }

    const hostname = application.bindAddress === '127.0.0.1'
      ? '127.0.0.1'
      : window.location.hostname;
    window.open(`http://${hostname}:${application.hostPort}`, '_blank', 'noopener,noreferrer');
  };

  const runApplicationAction = async (application, action) => {
    setDesktopMenu(null);
    try {
      await executeApplicationAction(application, action);
    } catch (error) {
      showDialog({ title: 'İşlem Hatası', message: error.message, type: 'error' });
    }
  };

  const openApplicationSettings = (application) => {
    setDesktopMenu(null);
    openWindow({
      id: 'settings',
      type: 'settings',
      title: 'Ayarlar',
      component: null,
      width: 1000,
      height: 680,
      navigation: {
        tab: 'applications',
        applicationId: application.id,
        requestId: Date.now()
      }
    });
  };

  const checkApplicationUpdate = async (application) => {
    setDesktopMenu(null);
    try {
      const { update: result, plan } = await checkAndPlanApplicationUpdate(application.id);
      if (plan) {
        showDialog({
          title: 'Güncellemeyi Uygula',
          message: updateConfirmationMessage(plan),
          type: 'confirm',
          confirmText: 'Güncelle',
          cancelText: 'Vazgeç',
          onConfirm: async () => {
            try {
              const operation = await applyApplicationUpdate(plan.planId);
              await refreshApplications();
              showDialog({ title: 'Güncelleme Tamamlandı', message: operation.message, type: 'success' });
            } catch (error) {
              showDialog({ title: 'Güncelleme Tamamlanamadı', message: error.message, type: 'error' });
            }
          }
        });
        return;
      }
      showDialog({
        title: result.status === 'update-available' ? 'Güncelleme Bulundu' : 'Güncelleme Denetimi',
        message: result.message,
        type: 'info',
        confirmText: 'Tamam'
      });
    } catch (error) {
      showDialog({ title: 'Güncelleme Denetimi', message: error.message, type: 'error' });
    }
  };

  const removeDesktopShortcut = async (application) => {
    setDesktopMenu(null);
    try {
      await setDesktopShortcut(application, false);
      setSelectedIds((current) => current.filter((id) => id !== `application:${application.id}`));
    } catch (error) {
      showDialog({ title: 'Kısayol Kaldırılamadı', message: error.message, type: 'error' });
    }
  };

  const handleDesktopItemDoubleClick = (item) => {
    if (item.desktopKind === 'application') {
      handleOpenApplication(item.application);
      return;
    }
    handleFileDoubleClick(item.file);
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
      case 'settings': return <SettingsApp target={win.navigation} />;
      case 'files': return <FilesApp initialPath={win.initialPath} />;
      case 'text-viewer': return <TextEditorApp filePath={win.filePath} />;
      case 'image-viewer': return <ImageViewerApp filePath={win.filePath} />;
      case 'media-player': return <MediaPlayerApp filePath={win.filePath} ext={win.ext} />;
      case 'terminal': return <TerminalApp />;
      case 'store': return <AppStoreApp />;
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
        {desktopItems.map((item) => {
          const isSelected = selectedIds.includes(item.desktopId);
          const pos = getDesktopItemPosition(item);
          const folderState = item.desktopKind === 'file' && item.type === 'folder'
            ? folderApplicationOperationalState(
                canonicalDesktopPath(`/Masaüstü/${item.name}`),
                visibleDesktopApplications,
                applicationActions
              )
            : null;

          return (
            <div
              key={item.desktopId}
              className="desktop-file"
              ref={el => fileRefs.current[item.desktopId] = el}
              draggable={true}
              onDragStart={(e) => handleDragStart(e, item)}
              onDragOver={item.desktopKind === 'file' && item.type === 'folder' ? handleDragOver : undefined}
              onDrop={item.desktopKind === 'file' && item.type === 'folder'
                ? (e) => handleDesktopFolderDrop(e, item.file)
                : undefined}
              onClick={(e) => handleDesktopItemClick(e, item.desktopId)}
              onDoubleClick={() => handleDesktopItemDoubleClick(item)}
              onContextMenu={(e) => handleContextMenu(e, item)}
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
              {item.desktopKind === 'application' ? (() => {
                const state = applicationOperationalState(
                  item.application,
                  applicationActions[item.application.id]
                );
                const dotColor = (APPLICATION_STATUS[state] || APPLICATION_STATUS.stopped).color;

                return (
                  <div style={{ position: 'relative', width: '48px', height: '48px' }}>
                    <div style={{ width: '100%', height: '100%', background: 'rgba(255,255,255,0.9)', borderRadius: '10px', padding: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 10px rgba(0,0,0,0.2)' }}>
                      <ApplicationLogo app={item.application} size={32} />
                    </div>
                    <div
                      style={{
                        position: 'absolute', right: '-4px', bottom: '-4px', width: '14px', height: '14px',
                        borderRadius: '50%', background: dotColor, border: '2px solid rgba(20, 20, 25, 0.9)',
                        boxShadow: '0 2px 4px rgba(0,0,0,0.3)', zIndex: 2
                      }}
                      title={`Durum: ${state}`}
                    />
                  </div>
                );
              })() : folderState ? (
                <div style={{ position: 'relative', width: '48px', height: '48px' }}>
                  {getFileIcon(item.file)}
                  <div
                    style={{
                      position: 'absolute', right: '-4px', bottom: '-4px', width: '14px', height: '14px',
                      borderRadius: '50%',
                      background: (APPLICATION_STATUS[folderState] || APPLICATION_STATUS.stopped).color,
                      border: '2px solid rgba(20, 20, 25, 0.9)',
                      boxShadow: '0 2px 4px rgba(0,0,0,0.3)', zIndex: 2
                    }}
                    title={`Klasör durumu: ${folderState}`}
                  />
                </div>
              ) : getFileIcon(item.file)}
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
                {item.name}
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
          {desktopMenu.type === 'application' ? (
            <>
              <div className="context-item" onClick={() => handleOpenApplication(desktopMenu.item.application)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>Aç</div>
              <div className="context-item" onClick={() => openApplicationSettings(desktopMenu.item.application)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}><SettingsIcon size={14} /> Ayarlar'a Git</div>
              {desktopMenu.item.application.capabilities.checkUpdates && (
                <div className="context-item" onClick={() => checkApplicationUpdate(desktopMenu.item.application)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}><RotateCw size={14} /> Güncellemeleri Denetle</div>
              )}
              <div style={{ height: '1px', background: 'rgba(255,255,255,0.1)', margin: '4px 0' }}></div>
              {desktopMenu.item.application.capabilities.stop ? (
                <div className="context-item" onClick={() => runApplicationAction(desktopMenu.item.application, 'stop')} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}><Square size={14} /> Durdur</div>
              ) : desktopMenu.item.application.capabilities.start ? (
                <div className="context-item" onClick={() => runApplicationAction(desktopMenu.item.application, 'start')} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}><Play size={14} /> Başlat</div>
              ) : null}
              {desktopMenu.item.application.capabilities.restart && (
                <div className="context-item" onClick={() => runApplicationAction(desktopMenu.item.application, 'restart')} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}><RotateCw size={14} /> Yeniden Başlat</div>
              )}
              <div style={{ height: '1px', background: 'rgba(255,255,255,0.1)', margin: '4px 0' }}></div>
              <div className="context-item" onClick={() => removeDesktopShortcut(desktopMenu.item.application)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', color: '#ff8a84', display: 'flex', alignItems: 'center', gap: '6px' }}><X size={14} /> Masaüstünden Kaldır</div>
            </>
          ) : desktopMenu.type === 'file' ? (
            <>
              <div className="context-item" onClick={() => handleFileDoubleClick(desktopMenu.item.file)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>Aç</div>
              <div className="context-item" onClick={() => handleRename(desktopMenu.item.file)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>Yeniden Adlandır</div>
              <div className="context-item" onClick={() => handleDelete(desktopMenu.item.file)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', color: '#ff5f56' }}>Sil</div>
            </>
          ) : (
            <>
              <div className="context-item" onClick={refreshDesktop} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>Masaüstünü Yenile</div>
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

  useEffect(() => {
    const preventBrowserContextMenu = (event) => event.preventDefault();
    document.addEventListener('contextmenu', preventBrowserContextMenu);
    return () => document.removeEventListener('contextmenu', preventBrowserContextMenu);
  }, []);

  if (authState === 'loading') return <div style={{ background: '#000', width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>Loading...</div>;
  if (authState === 'needs_setup') return <SetupScreen />;
  if (authState === 'locked') return <LockScreen />;

  return (
    <DialogProvider>
      <ApplicationProvider>
        <WindowProvider>
          <Desktop />
        </WindowProvider>
      </ApplicationProvider>
    </DialogProvider>
  );
}

export default App;
