import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Play, RotateCw, Settings as SettingsIcon, Square, Trash2, X } from 'lucide-react';
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
import CodexApp from './apps/CodexApp';
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
import { ApplicationRemovalProvider, useApplicationRemoval } from './contexts/ApplicationRemovalContext';
import { useAuth } from './contexts/AuthContext';
import SetupScreen from './components/auth/SetupScreen';
import LockScreen from './components/auth/LockScreen';
import { apiFetch } from './api';
import {
  applyApplicationUpdate,
  checkAndPlanApplicationUpdate,
  updateConfirmationMessage
} from './utils/applicationUpdates';

const createDesktopPointerPreview = (draggedItems, fileElements) => {
  const sources = draggedItems.map((item) => ({
    item,
    element: fileElements[item.id],
    rect: fileElements[item.id] && fileElements[item.id].getBoundingClientRect()
  })).filter((source) => source.element && source.rect);
  if (sources.length === 0) return null;

  const left = Math.min(...sources.map((source) => source.rect.left));
  const top = Math.min(...sources.map((source) => source.rect.top));
  const right = Math.max(...sources.map((source) => source.rect.right));
  const bottom = Math.max(...sources.map((source) => source.rect.bottom));
  const preview = document.createElement('div');
  Object.assign(preview.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: `${right - left}px`,
    height: `${bottom - top}px`,
    pointerEvents: 'none',
    zIndex: '10000',
    opacity: '0.85',
    contain: 'layout paint style',
    willChange: 'transform',
    transform: `translate3d(${left}px, ${top}px, 0)`
  });

  sources.forEach(({ element, rect }) => {
    const clone = element.cloneNode(true);
    Object.assign(clone.style, {
      position: 'absolute',
      left: `${rect.left - left}px`,
      top: `${rect.top - top}px`,
      width: `${rect.width}px`,
      minHeight: `${rect.height}px`,
      margin: '0',
      transform: 'none',
      transition: 'none',
      pointerEvents: 'none'
    });
    preview.appendChild(clone);
  });

  document.body.appendChild(preview);
  return { element: preview, left, top };
};

const Desktop = () => {
  const { windows, openWindow } = useWindowManager();
  const { showDialog } = useDialog();
  const { openApplicationRemoval } = useApplicationRemoval();
  const {
    actions: applicationActions,
    applications,
    refreshApplications,
    runApplicationAction: executeApplicationAction,
    setDesktopShortcut,
    setDesktopShortcutLocation
  } = useApplicationInventory();
  const visibleDesktopApplications = useMemo(() => applications.filter((application) => (
    application.desktopShortcutVisible !== false
  )), [applications]);
  const desktopApplications = useMemo(() => visibleDesktopApplications.filter((application) => (
    applicationShortcutPath(application) === DESKTOP_ROOT
  )), [visibleDesktopApplications]);
  const [desktopMenu, setDesktopMenu] = useState(null);
  const [desktopFiles, setDesktopFiles] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [selectionBox, setSelectionBox] = useState(null);
  const gridRef = useRef(null);
  const fileRefs = useRef({});
  const isDraggingMarquee = useRef(false);
  const activePointerDrag = useRef(null);
  const suppressDesktopClick = useRef(false);

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

      if (!changed) return current;
      localStorage.setItem('desktop_positions_v3', JSON.stringify(updated));
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

  useEffect(() => () => activePointerDrag.current?.cleanup(), []);

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

  const desktopDragData = (item, pointerX, pointerY) => {
    const dragElement = fileRefs.current[item.desktopId];
    if (!dragElement) return null;
    const rect = dragElement.getBoundingClientRect();
    let draggedItems;
    if (selectedIds.includes(item.desktopId) && selectedIds.length > 1) {
      const anchorPosition = getDesktopItemPosition(item);
      draggedItems = desktopItems
        .filter((candidate) => selectedIds.includes(candidate.desktopId))
        .map((candidate) => {
          const position = getDesktopItemPosition(candidate);
          return {
            id: candidate.desktopId,
            name: candidate.name,
            positionKey: candidate.positionKey,
            desktopKind: candidate.desktopKind,
            applicationId: candidate.desktopKind === 'application' ? candidate.application.id : null,
            relX: position.left - anchorPosition.left,
            relY: position.top - anchorPosition.top
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
    return {
      files: draggedItems,
      sourcePath: 'Masaüstü',
      offsetX: pointerX - rect.left,
      offsetY: pointerY - rect.top
    };
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const moveDesktopItemsToPath = (data, targetPath) => {
    const filesToMove = data.files || (data.name ? [{ name: data.name }] : []);
    if (filesToMove.length === 0 || typeof targetPath !== 'string') return;
    const targetDesktopPath = canonicalDesktopPath(targetPath);
    const comparablePath = (value) => {
      const segments = String(value || '/').split('/').filter(Boolean);
      return segments.length === 0 ? '/' : `/${segments.join('/')}`;
    };
    const sourceDirectory = comparablePath(data.sourcePath);
    const targetDirectory = comparablePath(targetPath);
    const movesFilesystemItems = filesToMove.some((file) => file.desktopKind !== 'application');
    const promises = filesToMove.map((file) => {
      if (file.desktopKind === 'application' && file.applicationId) {
        const application = applications.find((candidate) => candidate.id === file.applicationId);
        if (!application || !targetDesktopPath) {
          return Promise.reject(new Error('Uygulama yalnız Masaüstü klasörlerine taşınabilir'));
        }
        return setDesktopShortcutLocation(application, targetDesktopPath);
      }
      if (sourceDirectory === targetDirectory) return Promise.resolve();
      const sourcePath = data.sourcePath;
      const sourceFile = sourcePath === '/'
        ? `/${file.name}`
        : `${sourcePath === 'Masaüstü' ? '/Masaüstü' : sourcePath}/${file.name}`;
      if (comparablePath(sourceFile) === targetDirectory) return Promise.resolve();
      return apiFetch('/api/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: sourceFile, targetPath })
      });
    });

    Promise.all(promises).then(() => {
      if (movesFilesystemItems) {
        window.dispatchEvent(new Event('refresh_files'));
        refreshApplications({ quiet: true }).catch(() => {});
      }
    }).catch((error) => {
      console.error('Taşıma hatası:', error);
      showDialog({ title: 'Hata', message: 'Öğeler taşınamadı.', type: 'error' });
    });
  };

  const applyDesktopDrop = (data, clientX, clientY, desktopRect) => {
    const filesToMove = data.files || (data.name ? [{
      name: data.name,
      positionKey: data.name,
      desktopKind: 'file',
      relX: 0,
      relY: 0
    }] : []);
    if (filesToMove.length === 0) return;
    if (data.sourcePath && data.sourcePath !== 'Masaüstü') {
      moveDesktopItemsToPath(data, DESKTOP_ROOT);
      return;
    }

    const marginX = 20;
    const marginY = 20;
    const taskbarHeight = 80;
    const availableWidth = desktopRect.width - (2 * marginX);
    const availableHeight = desktopRect.height - taskbarHeight - (2 * marginY);
    const maxColumns = Math.max(1, Math.floor(availableWidth / 100));
    const maxRows = Math.max(1, Math.floor(availableHeight / 100));
    const cellWidth = availableWidth / maxColumns;
    const cellHeight = availableHeight / maxRows;
    const rawX = (clientX - desktopRect.left) - data.offsetX;
    const rawY = (clientY - desktopRect.top) - data.offsetY;
    const column = Math.min(maxColumns - 1, Math.max(0, Math.round((rawX - marginX) / cellWidth)));
    const row = Math.min(maxRows - 1, Math.max(0, Math.round((rawY - marginY) / cellHeight)));

    const placements = filesToMove.map((file) => ({
      file,
      column: Math.min(maxColumns - 1, Math.max(0, column + Math.round((file.relX || 0) / cellWidth))),
      row: Math.min(maxRows - 1, Math.max(0, row + Math.round((file.relY || 0) / cellHeight)))
    }));
    const collides = placements.some((placement) => desktopItems.some((existing) => {
      if (filesToMove.some((dragged) => (
        (dragged.positionKey || dragged.name) === existing.positionKey
      ))) return false;
      const existingPosition = positions[existing.positionKey] || {};
      return existingPosition.col === placement.column && existingPosition.row === placement.row;
    }));
    if (collides) return;

    const nextPositions = { ...positions };
    placements.forEach(({ file, column: nextColumn, row: nextRow }) => {
      nextPositions[file.positionKey || file.name] = { col: nextColumn, row: nextRow };
    });
    setPositions(nextPositions);
    localStorage.setItem('desktop_positions_v3', JSON.stringify(nextPositions));
  };

  const handleDesktopDrop = (e) => {
    e.preventDefault();
    const dataString = e.dataTransfer.getData('text/plain');
    if (!dataString) return;
    try {
      applyDesktopDrop(JSON.parse(dataString), e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
    } catch (error) {
      console.error('Sürükle bırak parse hatası:', error);
    }
  };

  const handleDesktopFolderDrop = (e, targetFolder) => {
    e.preventDefault();
    e.stopPropagation();
    const dataStr = e.dataTransfer.getData('text/plain');
    if (!dataStr) return;
    
    try {
      const data = JSON.parse(dataStr);
      const targetPath = canonicalDesktopPath(`/Masaüstü/${targetFolder.name}`);
      moveDesktopItemsToPath(data, targetPath);
    } catch (err) {
      console.error(err);
    }
  };

  const handleDesktopPointerDown = (e, item) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
    const data = desktopDragData(item, e.clientX, e.clientY);
    if (!data) return;
    activePointerDrag.current?.cleanup();

    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const sourceElement = fileRefs.current[item.desktopId];
    let latestX = startX;
    let latestY = startY;
    let preview = null;
    let animationFrame = null;
    let dragging = false;

    const renderPreview = () => {
      animationFrame = null;
      if (!preview) return;
      const x = preview.left + latestX - startX;
      const y = preview.top + latestY - startY;
      preview.element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('blur', onPointerCancel);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      if (preview && preview.element.isConnected) preview.element.remove();
      if (sourceElement?.hasPointerCapture(pointerId)) sourceElement.releasePointerCapture(pointerId);
      if (activePointerDrag.current?.cleanup === cleanup) activePointerDrag.current = null;
    };
    const beginDrag = () => {
      dragging = true;
      if (!selectedIds.includes(item.desktopId)) setSelectedIds([item.desktopId]);
      setDesktopMenu(null);
      preview = createDesktopPointerPreview(data.files, fileRefs.current);
    };
    const onPointerMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      latestX = moveEvent.clientX;
      latestY = moveEvent.clientY;
      if (!dragging && Math.hypot(latestX - startX, latestY - startY) < 4) return;
      if (!dragging) beginDrag();
      moveEvent.preventDefault();
      if (animationFrame === null) animationFrame = window.requestAnimationFrame(renderPreview);
    };
    const finishDrag = (upEvent, cancelled) => {
      if (upEvent.pointerId !== undefined && upEvent.pointerId !== pointerId) return;
      const dropX = upEvent.clientX ?? latestX;
      const dropY = upEvent.clientY ?? latestY;
      cleanup();
      if (!dragging || cancelled) return;
      suppressDesktopClick.current = true;
      window.setTimeout(() => { suppressDesktopClick.current = false; }, 250);
      const hitElement = document.elementFromPoint(dropX, dropY);
      const pathTarget = hitElement && hitElement.closest('[data-foxos-drop-path]');
      if (pathTarget) {
        moveDesktopItemsToPath(data, pathTarget.dataset.foxosDropPath);
        return;
      }
      const desktopGrid = hitElement && hitElement.closest('[data-foxos-desktop-grid="true"]');
      const desktop = desktopGrid && desktopGrid.closest('.desktop');
      if (desktop) applyDesktopDrop(data, dropX, dropY, desktop.getBoundingClientRect());
    };
    const onPointerUp = (upEvent) => finishDrag(upEvent, false);
    const onPointerCancel = (cancelEvent) => finishDrag(cancelEvent, true);

    if (sourceElement?.setPointerCapture) sourceElement.setPointerCapture(pointerId);
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('blur', onPointerCancel);
    activePointerDrag.current = { cleanup };
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
    if (suppressDesktopClick.current) {
      suppressDesktopClick.current = false;
      e.preventDefault();
      return;
    }
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
          pendingText: 'Güncelleniyor…',
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
    if (suppressDesktopClick.current) return;
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
      case 'codex': return <CodexApp />;
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
        data-foxos-desktop-grid="true"
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
              draggable={false}
              data-foxos-drop-path={item.desktopKind === 'file' && item.type === 'folder'
                ? canonicalDesktopPath(`/Masaüstü/${item.name}`)
                : undefined}
              onPointerDown={(e) => handleDesktopPointerDown(e, item)}
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
              {(desktopMenu.item.application.capabilities.stop || desktopMenu.item.application.capabilities.start || desktopMenu.item.application.capabilities.restart) && (
                <>
                  <div style={{ height: '1px', background: 'rgba(255,255,255,0.1)', margin: '4px 0' }} />
                  {desktopMenu.item.application.capabilities.stop ? (
                    <div className="context-item" onClick={() => runApplicationAction(desktopMenu.item.application, 'stop')} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}><Square size={14} /> Durdur</div>
                  ) : desktopMenu.item.application.capabilities.start ? (
                    <div className="context-item" onClick={() => runApplicationAction(desktopMenu.item.application, 'start')} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}><Play size={14} /> Başlat</div>
                  ) : null}
                  {desktopMenu.item.application.capabilities.restart && (
                    <div className="context-item" onClick={() => runApplicationAction(desktopMenu.item.application, 'restart')} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}><RotateCw size={14} /> Yeniden Başlat</div>
                  )}
                </>
              )}
              <div style={{ height: '1px', background: 'rgba(255,255,255,0.1)', margin: '4px 0' }} />
              <div className="context-item" onClick={() => removeDesktopShortcut(desktopMenu.item.application)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}><X size={14} /> Masaüstünden Kaldır</div>
              <div className="context-item" onClick={() => openApplicationRemoval(desktopMenu.item.application)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', color: '#ff5f56', display: 'flex', alignItems: 'center', gap: '6px' }}><Trash2 size={14} /> Uygulamayı Kaldır</div>
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
        <ApplicationRemovalProvider>
          <WindowProvider>
            <Desktop />
          </WindowProvider>
        </ApplicationRemovalProvider>
      </ApplicationProvider>
    </DialogProvider>
  );
}

export default App;
