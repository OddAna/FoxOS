import React, { useCallback, useState, useEffect, useMemo, useRef } from 'react';
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
import CalendarApp from './apps/CalendarApp';
import WeatherApp from './apps/WeatherApp';
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
import ServerOnboarding from './components/auth/ServerOnboarding';
import { apiFetch } from './api';
import {
  applyApplicationUpdate,
  checkAndPlanApplicationUpdate,
  updateConfirmationMessage
} from './utils/applicationUpdates';
import { mobileDesktopLayout, paginateDesktopItems } from './utils/mobileDesktopLayout';
import {
  appearanceBackground,
  appearanceDesktopMetrics,
  appearanceShellMetrics,
  useAppearance
} from './utils/appearance';
import { useI18n } from './contexts/LocaleContext';

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
  const { t } = useI18n();
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
  const mobileDesktopPageRef = useRef(0);
  const [mobileDesktopPage, setMobileDesktopPage] = useState(0);
  const { appearance } = useAppearance();
  const desktopAppearance = useMemo(() => appearanceBackground(appearance), [appearance]);
  const desktopMetrics = useMemo(() => appearanceDesktopMetrics(appearance), [appearance]);
  const shellMetrics = useMemo(() => appearanceShellMetrics(appearance), [appearance]);

  const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const isMobileViewport = windowSize.width <= 720;

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

  const mobileLayout = mobileDesktopLayout({
    width: windowSize.width,
    height: windowSize.height,
    itemCount: desktopItems.length
  });
  const desktopPageGroups = isMobileViewport
    ? paginateDesktopItems(desktopItems, mobileLayout.itemsPerPage)
    : [desktopItems];

  const persistNewItemPositions = useCallback((items) => {
    if (window.innerWidth <= 720) return;
    setPositions((current) => {
      const updated = { ...current };
      const occupied = new Set();
      Object.values(updated).forEach((position) => {
        if (position.col !== undefined) occupied.add(`${position.col},${position.row}`);
      });

      const availableHeight = window.innerHeight - shellMetrics.topbarHeight - shellMetrics.dockReserve - 32;
      const maxRows = Math.max(1, Math.floor(availableHeight / desktopMetrics.cellTarget));
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
  }, [desktopMetrics.cellTarget, shellMetrics.dockReserve, shellMetrics.topbarHeight]);

  const getDesktopItemPosition = (item) => {
    const MARGIN_X = 20;
    const MARGIN_Y = 20;
    const desktopW = windowSize.width;
    const availableW = desktopW - (2 * MARGIN_X);
    const availableH = windowSize.height - shellMetrics.topbarHeight - shellMetrics.dockReserve - (2 * MARGIN_Y);

    const maxCols = Math.max(1, Math.floor(availableW / desktopMetrics.cellTarget));
    const maxRows = Math.max(1, Math.floor(availableH / desktopMetrics.cellTarget));

    const cellW = availableW / maxCols;
    const cellH = availableH / maxRows;

    let col, row;
    const savedPosition = positions[item.positionKey];
    if (savedPosition && savedPosition.col !== undefined) {
      col = Math.min(savedPosition.col, maxCols - 1);
      row = Math.min(savedPosition.row, maxRows - 1);
    } else {
      const index = desktopItems.findIndex((candidate) => candidate.desktopId === item.desktopId);
      if (index === -1) { col = 0; row = 0; }
      else {
        col = Math.floor(index / maxRows);
        row = index % maxRows;
        if (col >= maxCols) col = maxCols - 1;
      }
    }

    const gridLeft = MARGIN_X + (col * cellW);
    const gridTop = MARGIN_Y + (row * cellH);
    if (!appearance.snapToGrid) {
      const width = Math.min(desktopMetrics.cellTarget, availableW);
      const height = Math.min(desktopMetrics.cellTarget, availableH);
      return {
        left: Math.min(Math.max(MARGIN_X, Number(savedPosition?.x) || gridLeft), Math.max(MARGIN_X, desktopW - MARGIN_X - width)),
        top: Math.min(Math.max(MARGIN_Y, Number(savedPosition?.y) || gridTop), Math.max(MARGIN_Y, availableH + MARGIN_Y - height)),
        width,
        height
      };
    }

    return { left: gridLeft, top: gridTop, width: cellW, height: cellH };
  };

  const fetchDesktopFiles = useCallback(async () => {
    try {
      const response = await apiFetch('/api/files?path=Masaüstü');
      const data = await response.json();
      const newFiles = data.items || [];
      setDesktopFiles(newFiles);
      persistNewItemPositions(newFiles.map((file) => ({ positionKey: file.name })));
    } catch (err) {
      console.error('Desktop files could not be loaded:', err);
    }
  }, [persistNewItemPositions]);

  const refreshDesktop = () => {
    fetchDesktopFiles();
    refreshApplications({ quiet: true }).catch((error) => {
      console.error('Server applications could not be loaded:', error);
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
  }, [fetchDesktopFiles]);

  useEffect(() => () => activePointerDrag.current?.cleanup(), []);

  useEffect(() => {
    persistNewItemPositions(desktopApplications.map((application) => ({
      positionKey: `application:${application.id}`
    })));
  }, [desktopApplications, persistNewItemPositions]);

  useEffect(() => {
    if (isMobileViewport) return;
    persistNewItemPositions([
      ...desktopFiles.map((file) => ({ positionKey: file.name })),
      ...desktopApplications.map((application) => ({ positionKey: `application:${application.id}` }))
    ]);
  }, [isMobileViewport, desktopFiles, desktopApplications, persistNewItemPositions]);

  useEffect(() => {
    const page = Math.min(mobileDesktopPageRef.current, mobileLayout.pageCount - 1);
    mobileDesktopPageRef.current = page;
    setMobileDesktopPage((current) => current === page ? current : page);
    if (!isMobileViewport || !gridRef.current) return undefined;

    const frame = window.requestAnimationFrame(() => {
      const grid = gridRef.current;
      const firstPage = grid?.querySelector('[data-mobile-desktop-page="0"]');
      const targetPage = grid?.querySelector(`[data-mobile-desktop-page="${page}"]`);
      if (grid && firstPage && targetPage) {
        grid.scrollLeft = targetPage.offsetLeft - firstPage.offsetLeft;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isMobileViewport, mobileLayout.pageCount, windowSize.width, windowSize.height]);

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
    // Do not open the desktop menu over the Dock, a window, or the menu bar.
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
          return Promise.reject(new Error(t('desktop.applicationMoveRestriction')));
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
      console.error('Move failed:', error);
      showDialog({ title: t('common.error'), message: t('desktop.moveError'), type: 'error' });
    });
  };

  const applyDesktopDrop = (data, clientX, clientY, gridRect) => {
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
    const availableWidth = gridRect.width - (2 * marginX);
    const availableHeight = gridRect.height - (2 * marginY);
    const maxColumns = Math.max(1, Math.floor(availableWidth / desktopMetrics.cellTarget));
    const maxRows = Math.max(1, Math.floor(availableHeight / desktopMetrics.cellTarget));
    const cellWidth = availableWidth / maxColumns;
    const cellHeight = availableHeight / maxRows;
    const rawX = (clientX - gridRect.left) - (Number(data.offsetX) || 0);
    const rawY = (clientY - gridRect.top) - (Number(data.offsetY) || 0);
    const column = Math.min(maxColumns - 1, Math.max(0, Math.round((rawX - marginX) / cellWidth)));
    const row = Math.min(maxRows - 1, Math.max(0, Math.round((rawY - marginY) / cellHeight)));
    const freeWidth = Math.min(desktopMetrics.cellTarget, availableWidth);
    const freeHeight = Math.min(desktopMetrics.cellTarget, availableHeight);
    const freeX = Math.min(Math.max(marginX, rawX), Math.max(marginX, gridRect.width - marginX - freeWidth));
    const freeY = Math.min(Math.max(marginY, rawY), Math.max(marginY, gridRect.height - marginY - freeHeight));

    const placements = filesToMove.map((file) => {
      const positionKey = file.positionKey || file.name;
      const previousGridPosition = positions[positionKey];
      const requestedColumn = column + Math.round((file.relX || 0) / cellWidth);
      const requestedRow = row + Math.round((file.relY || 0) / cellHeight);
      const nextColumn = Math.min(maxColumns - 1, Math.max(0, !appearance.snapToGrid && previousGridPosition?.col !== undefined
        ? previousGridPosition.col
        : requestedColumn));
      const nextRow = Math.min(maxRows - 1, Math.max(0, !appearance.snapToGrid && previousGridPosition?.row !== undefined
        ? previousGridPosition.row
        : requestedRow));
      const nextX = appearance.snapToGrid
        ? marginX + (nextColumn * cellWidth)
        : Math.min(Math.max(marginX, freeX + (file.relX || 0)), Math.max(marginX, gridRect.width - marginX - freeWidth));
      const nextY = appearance.snapToGrid
        ? marginY + (nextRow * cellHeight)
        : Math.min(Math.max(marginY, freeY + (file.relY || 0)), Math.max(marginY, gridRect.height - marginY - freeHeight));
      return { file, column: nextColumn, row: nextRow, x: nextX, y: nextY };
    });
    const collides = appearance.snapToGrid && placements.some((placement) => desktopItems.some((existing) => {
      if (filesToMove.some((dragged) => (
        (dragged.positionKey || dragged.name) === existing.positionKey
      ))) return false;
      const existingPosition = positions[existing.positionKey] || {};
      return existingPosition.col === placement.column && existingPosition.row === placement.row;
    }));
    if (collides) return;

    const nextPositions = { ...positions };
    placements.forEach(({ file, column: nextColumn, row: nextRow, x, y }) => {
      nextPositions[file.positionKey || file.name] = { col: nextColumn, row: nextRow, x, y };
    });
    setPositions(nextPositions);
    localStorage.setItem('desktop_positions_v3', JSON.stringify(nextPositions));
  };

  const handleDesktopDrop = (e) => {
    e.preventDefault();
    const dataString = e.dataTransfer.getData('text/plain');
    if (!dataString) return;
    try {
      const gridRect = gridRef.current?.getBoundingClientRect() || e.currentTarget.getBoundingClientRect();
      applyDesktopDrop(JSON.parse(dataString), e.clientX, e.clientY, gridRect);
    } catch (error) {
      console.error('Could not parse drag-and-drop data:', error);
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
    if (isMobileViewport || e.pointerType === 'touch') return;
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
      if (desktopGrid) applyDesktopDrop(data, dropX, dropY, desktopGrid.getBoundingClientRect());
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
      title: t('desktop.deleteFileTitle'),
      message: t('desktop.deleteFileMessage', { name: file.name }),
      type: 'warning',
      confirmText: t('desktop.deleteFileConfirm'),
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
          showDialog({ title: t('common.error'), message: t('desktop.deleteFileError'), type: 'error' });
        }
      }
    });
  };

  const handleRename = (file) => {
    setDesktopMenu(null);
    showDialog({
      title: t('desktop.renameTitle'),
      message: t('desktop.renameMessage', { name: file.name }),
      type: 'prompt',
      defaultValue: file.name,
      confirmText: t('common.save'),
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
          .catch(() => showDialog({ title: t('common.error'), message: t('desktop.renameError'), type: 'error' }));
      }
    });
  };

  const handleNewFolder = () => {
    setDesktopMenu(null);
    showDialog({
      title: t('desktop.newFolderTitle'),
      message: t('desktop.newFolderMessage'),
      type: 'prompt',
      defaultValue: t('desktop.newFolderDefaultName'),
      confirmText: t('desktop.create'),
      onConfirm: (name) => {
        if (!name) return;
        apiFetch('/api/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/Masaüstü', name })
        }).then(() => fetchDesktopFiles())
          .catch(() => showDialog({ title: t('common.error'), message: t('desktop.newFolderError'), type: 'error' }));
      }
    });
  };

  const handleDesktopItemClick = (e, item) => {
    e.stopPropagation();
    if (suppressDesktopClick.current) {
      suppressDesktopClick.current = false;
      e.preventDefault();
      return;
    }
    const id = item.desktopId;
    if (isMobileViewport && !e.ctrlKey && !e.metaKey) {
      setSelectedIds([]);
      setDesktopMenu(null);
      handleDesktopItemDoubleClick(item);
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
        title: t('applications.serviceStoppedTitle'),
        message: t('desktop.serviceStoppedMessage'),
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
        title: t('applications.noAccessTitle'),
        message: t('applications.noAccessMessage'),
        type: 'info'
      });
      return;
    }

    const localFoxOS = ['127.0.0.1', 'localhost'].includes(window.location.hostname);
    if (application.bindAddress === '127.0.0.1' && !localFoxOS) {
      showDialog({
        title: t('applications.privateAccessTitle'),
        message: t('applications.privateAccessMessage', { port: application.hostPort }),
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
      showDialog({ title: t('desktop.operationErrorTitle'), message: error.message, type: 'error' });
    }
  };

  const openApplicationSettings = (application) => {
    setDesktopMenu(null);
    openWindow({
      id: 'settings',
      type: 'settings',
      title: t('common.settings'),
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

  const openAppearanceSettings = (section = 'device') => {
    setDesktopMenu(null);
    openWindow({
      id: 'settings',
      type: 'settings',
      title: t('common.settings'),
      component: null,
      width: 1000,
      height: 680,
      navigation: {
        tab: 'display',
        section,
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
          title: t('applications.applyUpdateTitle'),
          message: updateConfirmationMessage(plan, t),
          type: 'confirm',
          confirmText: t('applications.update'),
          cancelText: t('common.cancel'),
          pendingText: t('applications.updating'),
          onConfirm: async () => {
            try {
              const operation = await applyApplicationUpdate(plan.planId);
              await refreshApplications();
              showDialog({ title: t('applications.updateCompleteTitle'), message: operation.message, type: 'success' });
            } catch (error) {
              showDialog({ title: t('desktop.updateFailedTitle'), message: error.message, type: 'error' });
            }
          }
        });
        return;
      }
      showDialog({
        title: result.status === 'update-available' ? t('desktop.updateFoundTitle') : t('desktop.updateCheckTitle'),
        message: result.message,
        type: 'info',
        confirmText: t('dialog.confirm')
      });
    } catch (error) {
      showDialog({ title: t('desktop.updateCheckTitle'), message: error.message, type: 'error' });
    }
  };

  const removeDesktopShortcut = async (application) => {
    setDesktopMenu(null);
    try {
      await setDesktopShortcut(application, false);
      setSelectedIds((current) => current.filter((id) => id !== `application:${application.id}`));
    } catch (error) {
      showDialog({ title: t('desktop.shortcutRemoveFailedTitle'), message: error.message, type: 'error' });
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

  const openWorkspaceEntry = (file, fullPath) => {
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

  const handleFileDoubleClick = (file) => {
    openWorkspaceEntry(file, `/Masaüstü/${file.name}`);
  };

  const handleSearchFileOpen = (file) => {
    openWorkspaceEntry(file, file.path);
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

  const scrollToMobileDesktopPage = (pageIndex) => {
    const grid = gridRef.current;
    const firstPage = grid?.querySelector('[data-mobile-desktop-page="0"]');
    const targetPage = grid?.querySelector(`[data-mobile-desktop-page="${pageIndex}"]`);
    if (!grid || !firstPage || !targetPage) return;
    grid.scrollTo({
      left: targetPage.offsetLeft - firstPage.offsetLeft,
      behavior: 'smooth'
    });
  };

  const handleMobileDesktopScroll = (event) => {
    if (!isMobileViewport) return;
    const pages = Array.from(event.currentTarget.querySelectorAll('[data-mobile-desktop-page]'));
    if (!pages.length) return;
    const firstOffset = pages[0].offsetLeft;
    const scrollLeft = event.currentTarget.scrollLeft;
    const nextPage = pages.reduce((closest, page, index) => {
      const distance = Math.abs(page.offsetLeft - firstOffset - scrollLeft);
      return distance < closest.distance ? { index, distance } : closest;
    }, { index: 0, distance: Number.POSITIVE_INFINITY }).index;
    mobileDesktopPageRef.current = nextPage;
    setMobileDesktopPage((current) => current === nextPage ? current : nextPage);
  };

  const startSelection = (e) => {
    if (isMobileViewport || e.pointerType === 'touch') {
      setSelectedIds([]);
      setSelectionBox(null);
      return;
    }
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
      case 'text-viewer': return <TextEditorApp filePath={win.filePath} initialLine={win.initialLine} />;
      case 'image-viewer': return <ImageViewerApp filePath={win.filePath} />;
      case 'media-player': return <MediaPlayerApp filePath={win.filePath} ext={win.ext} />;
      case 'terminal': return <TerminalApp />;
      case 'codex': return <CodexApp />;
      case 'store': return <AppStoreApp />;
      case 'calendar': return <CalendarApp target={win.navigation} />;
      case 'weather': return <WeatherApp />;
      default: return <div style={{ padding: 20, color: '#fff' }}>{t('shell.unknownApplication', { title: win.title })}</div>;
    }
  };

  return (
    <div 
      className="desktop" 
      style={desktopAppearance}
      onContextMenu={(e) => handleContextMenu(e, null)} 
      onClick={handleBackgroundClick}
      onDragOver={handleDragOver}
      onDrop={handleDesktopDrop}
    >
      <TopBar
        applications={applications}
        onOpenApplication={handleOpenApplication}
        onOpenFileResult={handleSearchFileOpen}
        onRefreshDesktop={refreshDesktop}
      />
      
      {/* Desktop icon grid */}
      <div 
        className={`desktop-grid${isMobileViewport ? ' is-mobile' : ''}`}
        ref={gridRef}
        data-foxos-desktop-grid="true"
        onPointerDown={startSelection}
        onScroll={handleMobileDesktopScroll}
        style={{
          position: 'absolute',
          top: 'var(--foxos-topbar-height)',
          left: '0',
          right: '0',
          bottom: 'var(--foxos-dock-reserve)',
          padding: '10px',
          zIndex: 1,
          overflow: 'hidden'
      }}>
        <div
          className={`desktop-pages-track${isMobileViewport ? '' : ' is-desktop'}`}
          style={isMobileViewport ? {
            '--mobile-desktop-columns': mobileLayout.columns,
            '--mobile-desktop-rows': mobileLayout.rows
          } : undefined}
        >
          {desktopPageGroups.map((pageItems, pageIndex) => (
            <section
              key={`desktop-page-${pageIndex}`}
              className={`desktop-page${isMobileViewport ? '' : ' is-desktop'}`}
              data-mobile-desktop-page={isMobileViewport ? pageIndex : undefined}
              aria-label={isMobileViewport ? t('desktop.pageLabel', { page: pageIndex + 1, count: mobileLayout.pageCount }) : undefined}
            >
        {pageItems.map((item) => {
          const isSelected = selectedIds.includes(item.desktopId);
          const pos = isMobileViewport ? null : getDesktopItemPosition(item);
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
              onClick={(e) => handleDesktopItemClick(e, item)}
              onDoubleClick={() => { if (!isMobileViewport) handleDesktopItemDoubleClick(item); }}
              onContextMenu={(e) => handleContextMenu(e, item)}
              style={{
                position: isMobileViewport ? 'relative' : 'absolute',
                left: pos ? `${pos.left}px` : undefined,
                top: pos ? `${pos.top}px` : undefined,
                width: pos ? `${pos.width}px` : '100%',
                minHeight: pos ? `${pos.height}px` : 0,
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
                  <div style={{ position: 'relative', width: `${desktopMetrics.iconSize}px`, height: `${desktopMetrics.iconSize}px` }}>
                    <div style={{ width: '100%', height: '100%', background: 'rgba(255,255,255,0.9)', borderRadius: `${desktopMetrics.iconRadius}px`, padding: `${desktopMetrics.iconPadding}px`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 10px rgba(0,0,0,0.2)' }}>
                      <ApplicationLogo app={item.application} size={desktopMetrics.logoSize} />
                    </div>
                    <div
                      style={{
                        position: 'absolute', right: '-4px', bottom: '-4px', width: `${desktopMetrics.statusSize}px`, height: `${desktopMetrics.statusSize}px`,
                        borderRadius: '50%', background: dotColor, border: '2px solid rgba(20, 20, 25, 0.9)',
                        boxShadow: '0 2px 4px rgba(0,0,0,0.3)', zIndex: 2
                      }}
                      title={t('desktop.applicationState', {
                        state: t((APPLICATION_STATUS[state] || APPLICATION_STATUS.stopped).labelKey)
                      })}
                    />
                  </div>
                );
              })() : folderState ? (
                <div style={{ position: 'relative', width: `${desktopMetrics.iconSize}px`, height: `${desktopMetrics.iconSize}px` }}>
                  {getFileIcon(item.file, desktopMetrics.iconSize)}
                  <div
                    style={{
                      position: 'absolute', right: '-4px', bottom: '-4px', width: `${desktopMetrics.statusSize}px`, height: `${desktopMetrics.statusSize}px`,
                      borderRadius: '50%',
                      background: (APPLICATION_STATUS[folderState] || APPLICATION_STATUS.stopped).color,
                      border: '2px solid rgba(20, 20, 25, 0.9)',
                      boxShadow: '0 2px 4px rgba(0,0,0,0.3)', zIndex: 2
                    }}
                    title={t('desktop.folderState', {
                      state: t((APPLICATION_STATUS[folderState] || APPLICATION_STATUS.stopped).labelKey)
                    })}
                  />
                </div>
              ) : getFileIcon(item.file, desktopMetrics.iconSize)}
              <span style={{
                color: '#fff',
                fontSize: `${desktopMetrics.labelSize}px`,
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
            </section>
          ))}
        </div>

        {/* Marquee Selection Box */}
        {!isMobileViewport && selectionBox && (
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

      {isMobileViewport && mobileLayout.pageCount > 1 && (
        <nav className="desktop-page-indicator" aria-label={t('desktop.pagesLabel')}>
          {desktopPageGroups.map((_, pageIndex) => (
            <button
              key={`desktop-page-dot-${pageIndex}`}
              type="button"
              className={pageIndex === mobileDesktopPage ? 'is-active' : ''}
              aria-label={t('desktop.goToPage', { page: pageIndex + 1 })}
              aria-current={pageIndex === mobileDesktopPage ? 'page' : undefined}
              onClick={(event) => {
                event.stopPropagation();
                scrollToMobileDesktopPage(pageIndex);
              }}
            />
          ))}
        </nav>
      )}

      {/* Window layer */}
      <div className="window-layer" style={{ position: 'absolute', top: 'var(--foxos-topbar-height)', left: 0, width: '100%', height: 'calc(100dvh - var(--foxos-topbar-height) - var(--foxos-dock-reserve))', zIndex: 10, pointerEvents: 'none' }}>
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

      {/* Desktop context menu */}
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
              <div className="context-item" onClick={() => handleOpenApplication(desktopMenu.item.application)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>{t('common.open')}</div>
              <div className="context-item" onClick={() => openApplicationSettings(desktopMenu.item.application)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}><SettingsIcon size={14} /> {t('desktop.goToSettings')}</div>
              {desktopMenu.item.application.capabilities.checkUpdates && (
                <div className="context-item" onClick={() => checkApplicationUpdate(desktopMenu.item.application)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}><RotateCw size={14} /> {t('applications.checkUpdates')}</div>
              )}
              {(desktopMenu.item.application.capabilities.stop || desktopMenu.item.application.capabilities.start || desktopMenu.item.application.capabilities.restart) && (
                <>
                  <div style={{ height: '1px', background: 'rgba(255,255,255,0.1)', margin: '4px 0' }} />
                  {desktopMenu.item.application.capabilities.stop ? (
                    <div className="context-item" onClick={() => runApplicationAction(desktopMenu.item.application, 'stop')} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}><Square size={14} /> {t('applications.stop')}</div>
                  ) : desktopMenu.item.application.capabilities.start ? (
                    <div className="context-item" onClick={() => runApplicationAction(desktopMenu.item.application, 'start')} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}><Play size={14} /> {t('applications.start')}</div>
                  ) : null}
                  {desktopMenu.item.application.capabilities.restart && (
                    <div className="context-item" onClick={() => runApplicationAction(desktopMenu.item.application, 'restart')} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}><RotateCw size={14} /> {t('applications.restart')}</div>
                  )}
                </>
              )}
              <div style={{ height: '1px', background: 'rgba(255,255,255,0.1)', margin: '4px 0' }} />
              <div className="context-item" onClick={() => removeDesktopShortcut(desktopMenu.item.application)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}><X size={14} /> {t('desktop.removeShortcut')}</div>
              <div className="context-item" onClick={() => openApplicationRemoval(desktopMenu.item.application)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', color: '#ff5f56', display: 'flex', alignItems: 'center', gap: '6px' }}><Trash2 size={14} /> {t('desktop.removeApplication')}</div>
            </>
          ) : desktopMenu.type === 'file' ? (
            <>
              <div className="context-item" onClick={() => handleFileDoubleClick(desktopMenu.item.file)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>{t('common.open')}</div>
              <div className="context-item" onClick={() => handleRename(desktopMenu.item.file)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>{t('desktop.renameTitle')}</div>
              <div className="context-item" onClick={() => handleDelete(desktopMenu.item.file)} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px', color: '#ff5f56' }}>{t('common.delete')}</div>
            </>
          ) : (
            <>
              <div className="context-item" onClick={refreshDesktop} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>{t('desktop.refresh')}</div>
              <div className="context-item" onClick={handleNewFolder} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>{t('desktop.newFolderTitle')}</div>
              <div style={{ height: '1px', background: 'rgba(255,255,255,0.1)', margin: '4px 0' }}></div>
              <div className="context-item" onClick={() => openAppearanceSettings('wallpaper')} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>{t('desktop.changeWallpaper')}</div>
              <div className="context-item" onClick={() => openAppearanceSettings('device')} style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}>{t('desktop.displaySettings')}</div>
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
  const { t } = useI18n();
  const { authState } = useAuth();

  useEffect(() => {
    const preventBrowserContextMenu = (event) => event.preventDefault();
    document.addEventListener('contextmenu', preventBrowserContextMenu);
    return () => document.removeEventListener('contextmenu', preventBrowserContextMenu);
  }, []);

  if (authState === 'loading') return <div style={{ background: '#000', width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>{t('shell.loading')}</div>;
  if (authState === 'needs_setup') return <SetupScreen />;
  if (authState === 'needs_onboarding') return <ServerOnboarding />;
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
