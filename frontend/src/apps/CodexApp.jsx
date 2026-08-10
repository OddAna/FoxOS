import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  CircleStop,
  Code2,
  History,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  X
} from 'lucide-react';
import { apiFetch } from '../api';
import { useWindowManager } from '../contexts/WindowContext';
import CodexMarkdown from './CodexMarkdown';
import './CodexApp.css';

const MODEL_STORAGE_KEY = 'foxos.codex.model';
const REASONING_STORAGE_KEY = 'foxos.codex.reasoning-effort';
const APPROVAL_POLICY_STORAGE_KEY = 'foxos.codex.approval-policy';
const ACTIVE_THREAD_STORAGE_KEY = 'foxos.codex.active-thread';
const DEFAULT_APPROVAL_POLICY = 'untrusted';
const NO_APPROVAL_POLICY = 'never';
const mobileViewport = () => typeof window !== 'undefined'
  && window.matchMedia('(max-width: 720px)').matches;
const REASONING_LABELS = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra'
};

const storedPreference = (key) => {
  try { return window.localStorage.getItem(key); } catch { return null; }
};

const savePreference = (key, value) => {
  try { window.localStorage.setItem(key, value); } catch {}
};

const removePreference = (key) => {
  try { window.localStorage.removeItem(key); } catch {}
};

const commandText = (value) => Array.isArray(value)
  ? value.map(String).join(' ')
  : String(value || '');

const fileChangeKind = (value) => typeof value === 'string'
  ? value
  : value && typeof value.type === 'string' ? value.type : 'changed';

const upsertEntry = (entries, id, patch) => {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index === -1) return [...entries, { id, ...patch }];
  const next = [...entries];
  next[index] = { ...next[index], ...patch };
  return next;
};

const applyEvents = (entries, events) => {
  let next = entries;
  for (const event of events) {
    const params = event.params || {};
    const item = params.item || {};
    if (event.method === 'item/agentMessage/delta') {
      const id = `agent:${params.itemId || event.sequence}`;
      const existing = next.find((entry) => entry.id === id);
      if (existing && existing.complete) continue;
      next = upsertEntry(next, id, {
        type: 'agent',
        text: `${existing && existing.text || ''}${params.delta || ''}`,
        complete: false
      });
    } else if (event.method === 'item/completed' && item.type === 'agentMessage') {
      next = upsertEntry(next, `agent:${item.id}`, {
        type: 'agent',
        text: item.text || '',
        complete: true
      });
    } else if (event.method === 'item/started' && item.type === 'commandExecution') {
      next = upsertEntry(next, `command:${item.id}`, {
        type: 'command',
        command: commandText(item.command),
        cwd: item.cwd || '/',
        output: '',
        status: item.status || 'inProgress'
      });
    } else if (event.method === 'item/commandExecution/outputDelta') {
      const id = `command:${params.itemId || event.sequence}`;
      const existing = next.find((entry) => entry.id === id);
      if (existing && existing.status && existing.status !== 'inProgress') continue;
      next = upsertEntry(next, id, {
        type: 'command',
        command: existing && existing.command || '',
        cwd: existing && existing.cwd || '/',
        output: `${existing && existing.output || ''}${params.delta || ''}`,
        status: existing && existing.status || 'inProgress'
      });
    } else if (event.method === 'item/completed' && item.type === 'commandExecution') {
      const id = `command:${item.id}`;
      const existing = next.find((entry) => entry.id === id);
      next = upsertEntry(next, id, {
        type: 'command',
        command: commandText(item.command) || existing && existing.command || '',
        cwd: item.cwd || existing && existing.cwd || '/',
        output: item.aggregatedOutput || existing && existing.output || '',
        status: item.status || 'completed',
        exitCode: item.exitCode
      });
    } else if (event.method === 'item/completed' && item.type === 'fileChange') {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      next = upsertEntry(next, `file:${item.id}`, {
        type: 'file',
        text: changes.length
          ? changes.map((change) => `${fileChangeKind(change.kind)}: ${change.path}`).join('\n')
          : 'Dosya değişiklikleri tamamlandı.',
        status: item.status || 'completed'
      });
    } else if (event.method === 'foxos/approvalRequested') {
      next = upsertEntry(next, `approval:${params.requestId}`, {
        type: 'approval',
        requestId: params.requestId,
        method: params.method,
        command: params.command,
        cwd: params.cwd,
        reason: params.reason,
        availableDecisions: params.availableDecisions,
        resolved: false
      });
    } else if (event.method === 'error') {
      next = upsertEntry(next, `error:${event.sequence}`, {
        type: 'error',
        text: params.error && params.error.message || 'Codex çalışması başarısız oldu.'
      });
    } else if (event.method === 'warning') {
      next = upsertEntry(next, `warning:${event.sequence}`, {
        type: 'warning',
        text: params.message || 'Codex bir uyarı bildirdi.'
      });
    }
  }
  return next;
};

const entriesFromThread = (thread) => {
  const entries = [];
  if (thread && thread.historyTruncated) {
    entries.push({
      id: 'warning:history-truncated',
      type: 'warning',
      text: 'Çok eski ayrıntıların bir bölümü görünüm sınırı nedeniyle gösterilmiyor; konuşma bağlamı Codex’te korunuyor.'
    });
  }
  for (const turn of Array.isArray(thread && thread.turns) ? thread.turns : []) {
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (item.type === 'userMessage') {
        const text = (Array.isArray(item.content) ? item.content : [])
          .filter((content) => content && content.type === 'text')
          .map((content) => content.text || '')
          .join('\n');
        if (text) entries.push({ id: `user:${item.id}`, type: 'user', text });
      } else if (item.type === 'agentMessage') {
        entries.push({
          id: `agent:${item.id}`,
          type: 'agent',
          text: item.text || '',
          complete: turn.status !== 'inProgress'
        });
      } else if (item.type === 'commandExecution') {
        entries.push({
          id: `command:${item.id}`,
          type: 'command',
          command: commandText(item.command),
          cwd: item.cwd || '/',
          output: item.aggregatedOutput || '',
          status: item.status || 'completed',
          exitCode: item.exitCode
        });
      } else if (item.type === 'fileChange') {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        entries.push({
          id: `file:${item.id}`,
          type: 'file',
          text: changes.length
            ? changes.map((change) => `${fileChangeKind(change.kind)}: ${change.path}`).join('\n')
            : 'Dosya değişiklikleri tamamlandı.',
          status: item.status || 'completed'
        });
      }
    }
    if (turn.error && turn.error.message) {
      entries.push({ id: `error:${turn.id}`, type: 'error', text: turn.error.message });
    }
  }
  return entries;
};

const activeTurnFromThread = (thread) => {
  const turns = Array.isArray(thread && thread.turns) ? thread.turns : [];
  return [...turns].reverse().find((turn) => turn.status === 'inProgress') || null;
};

const threadTitle = (thread) => thread.name || thread.preview || 'Yeni konuşma';

const eventThreadId = (event) => {
  const params = event && event.params || {};
  return params.threadId || params.thread?.id || params.turn?.threadId || null;
};

const localFileDetails = (href) => {
  let decoded = String(href || '');
  try { decoded = decodeURI(decoded); } catch {}
  decoded = decoded.split(/[?#]/, 1)[0];
  const location = decoded.match(/^(.*?):(\d+)(?::(\d+))?$/);
  const filePath = location ? location[1] : decoded;
  const line = location ? Number(location[2]) : null;
  const name = filePath.split('/').filter(Boolean).at(-1) || filePath;
  return { filePath, line, name };
};

const threadTime = (thread) => {
  const timestamp = thread.recencyAt || thread.updatedAt || thread.createdAt;
  if (!timestamp) return '';
  const date = new Date(timestamp * 1000);
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return new Intl.DateTimeFormat('tr-TR', sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short' }).format(date);
};

const CodexApp = () => {
  const { openWindow } = useWindowManager();
  const [connection, setConnection] = useState(null);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [approvalPolicy, setApprovalPolicy] = useState(() => (
    storedPreference(APPROVAL_POLICY_STORAGE_KEY) === NO_APPROVAL_POLICY
      ? NO_APPROVAL_POLICY
      : DEFAULT_APPROVAL_POLICY
  ));
  const [activeModel, setActiveModel] = useState('');
  const [activeReasoningEffort, setActiveReasoningEffort] = useState('');
  const [activeApprovalPolicy, setActiveApprovalPolicy] = useState('');
  const [threadId, setThreadId] = useState(null);
  const [activeTurnId, setActiveTurnId] = useState(null);
  const [entries, setEntries] = useState([]);
  const [threads, setThreads] = useState([]);
  const [nextThreadCursor, setNextThreadCursor] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [loadingMoreThreads, setLoadingMoreThreads] = useState(false);
  const [resumingThreadId, setResumingThreadId] = useState(null);
  const [startingTurn, setStartingTurn] = useState(false);
  const [steering, setSteering] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => !mobileViewport());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [historyError, setHistoryError] = useState(null);
  const cursorRef = useRef(0);
  const activityCursorRef = useRef(0);
  const bottomRef = useRef(null);
  const autoResumeAttemptedRef = useRef(false);
  const resumeConversationRef = useRef(null);
  const selectedThreadRef = useRef(null);

  const usable = Boolean(connection && connection.ready && connection.fullServer);
  const connectionReady = Boolean(connection && connection.ready);
  const selectedModelDetails = useMemo(
    () => models.find((entry) => entry.model === selectedModel) || null,
    [models, selectedModel]
  );
  const selectionReady = Boolean(selectedModelDetails && reasoningEffort);

  const openConnections = () => openWindow({
    id: 'settings',
    type: 'settings',
    title: 'Ayarlar',
    navigation: { tab: 'connections' },
    width: 800,
    height: 550
  });

  const openLocalFile = (href) => {
    const { filePath, line, name } = localFileDetails(href);
    if (!filePath.startsWith('/')) return;
    openWindow({
      id: `codex-file-${encodeURIComponent(`${filePath}:${line || 0}`).slice(0, 180)}`,
      type: 'text-viewer',
      title: line ? `${name}:${line}` : name,
      filePath: `/Sunucu${filePath}`,
      initialLine: line,
      width: 760,
      height: 590
    });
  };

  const loadConnection = async () => {
    const response = await apiFetch('/api/connections/codex');
    const payload = await response.json();
    setConnection(payload.connection);
    return payload.connection;
  };

  const refreshThreads = async () => {
    setThreadsLoading(true);
    setHistoryError(null);
    try {
      const response = await apiFetch('/api/codex/threads');
      const payload = await response.json();
      setThreads(Array.isArray(payload.threads) ? payload.threads : []);
      setNextThreadCursor(payload.nextCursor || null);
    } catch (requestError) {
      setHistoryError(requestError.message);
    } finally {
      setThreadsLoading(false);
    }
  };

  const loadMoreThreads = async () => {
    if (!nextThreadCursor || loadingMoreThreads) return;
    setLoadingMoreThreads(true);
    setHistoryError(null);
    try {
      const response = await apiFetch(`/api/codex/threads?cursor=${encodeURIComponent(nextThreadCursor)}`);
      const payload = await response.json();
      const incoming = Array.isArray(payload.threads) ? payload.threads : [];
      setThreads((current) => {
        const known = new Set(current.map((thread) => thread.id));
        return [...current, ...incoming.filter((thread) => !known.has(thread.id))];
      });
      setNextThreadCursor(payload.nextCursor || null);
    } catch (requestError) {
      setHistoryError(requestError.message);
    } finally {
      setLoadingMoreThreads(false);
    }
  };

  const resumeConversation = async (selectedThreadId, { silent = false } = {}) => {
    if (!selectedThreadId || resumingThreadId || startingTurn) return;
    if (selectedThreadId === threadId && !silent) return;
    setResumingThreadId(selectedThreadId);
    selectedThreadRef.current = selectedThreadId;
    setThreadId(selectedThreadId);
    setEntries([]);
    setActiveTurnId(null);
    setBusy(false);
    if (!silent && mobileViewport()) setSidebarOpen(false);
    cursorRef.current = 0;
    if (!silent) setError(null);
    try {
      const response = await apiFetch(`/api/codex/threads/${encodeURIComponent(selectedThreadId)}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalPolicy })
      });
      const payload = await response.json();
      const resumedThread = payload.thread;
      const activeTurn = activeTurnFromThread(resumedThread);
      cursorRef.current = 0;
      selectedThreadRef.current = resumedThread.id;
      setThreadId(resumedThread.id);
      setActiveModel(payload.model || '');
      setActiveReasoningEffort(payload.reasoningEffort || '');
      setActiveApprovalPolicy(payload.approvalPolicy || approvalPolicy);
      setEntries(entriesFromThread(resumedThread));
      setActiveTurnId(activeTurn && activeTurn.id || null);
      setBusy(Boolean(activeTurn));
      savePreference(ACTIVE_THREAD_STORAGE_KEY, resumedThread.id);
      setThreads((current) => {
        const summary = { ...resumedThread };
        delete summary.turns;
        delete summary.historyTruncated;
        return current.some((thread) => thread.id === resumedThread.id)
          ? current.map((thread) => thread.id === resumedThread.id ? { ...thread, ...summary } : thread)
          : [summary, ...current];
      });
    } catch (requestError) {
      if (
        requestError.status === 404 &&
        storedPreference(ACTIVE_THREAD_STORAGE_KEY) === selectedThreadId
      ) {
        removePreference(ACTIVE_THREAD_STORAGE_KEY);
      }
      if (selectedThreadRef.current === selectedThreadId || !selectedThreadRef.current) {
        setError(requestError.message);
        selectedThreadRef.current = null;
        setThreadId(null);
        setActiveTurnId(null);
        setBusy(false);
      }
    } finally {
      setResumingThreadId(null);
    }
  };
  resumeConversationRef.current = resumeConversation;

  useEffect(() => {
    loadConnection()
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 720px)');
    const syncSidebar = (event) => setSidebarOpen(!event.matches);
    query.addEventListener('change', syncSidebar);
    return () => query.removeEventListener('change', syncSidebar);
  }, []);

  useEffect(() => {
    selectedThreadRef.current = threadId;
  }, [threadId]);

  useEffect(() => {
    if (!connectionReady) {
      setModels([]);
      setSelectedModel('');
      setReasoningEffort('');
      return undefined;
    }
    let cancelled = false;
    setModelsLoading(true);
    apiFetch('/api/codex/models')
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        const availableModels = Array.isArray(payload.models) ? payload.models : [];
        if (!availableModels.length) throw new Error('Codex model listesi boş.');
        const savedModel = storedPreference(MODEL_STORAGE_KEY);
        const initialModel = availableModels.find((entry) => entry.model === savedModel) ||
          availableModels.find((entry) => entry.model === payload.defaultModel) ||
          availableModels[0];
        const availableEfforts = Array.isArray(initialModel.supportedReasoningEfforts)
          ? initialModel.supportedReasoningEfforts
          : [];
        const savedEffort = storedPreference(REASONING_STORAGE_KEY);
        const initialEffort = availableEfforts.includes(savedEffort)
          ? savedEffort
          : initialModel.defaultReasoningEffort || availableEfforts[0] || '';
        setModels(availableModels);
        setSelectedModel(initialModel.model);
        setReasoningEffort(initialEffort);
      })
      .catch((requestError) => {
        if (!cancelled) setError(requestError.message);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => { cancelled = true; };
  }, [connectionReady]);

  useEffect(() => {
    if (!usable) {
      setThreads([]);
      setNextThreadCursor(null);
      return;
    }
    refreshThreads();
  }, [usable]);

  useEffect(() => {
    if (!usable || threadsLoading || autoResumeAttemptedRef.current || threadId) return;
    autoResumeAttemptedRef.current = true;
    const savedThreadId = storedPreference(ACTIVE_THREAD_STORAGE_KEY);
    if (savedThreadId) resumeConversationRef.current(savedThreadId, { silent: true });
  }, [usable, threadsLoading, threadId]);

  useEffect(() => {
    if (!usable) return undefined;
    let cancelled = false;
    let pending = false;
    activityCursorRef.current = 0;
    const pollActivity = async () => {
      if (pending || cancelled) return;
      pending = true;
      try {
        const response = await apiFetch(`/api/codex/events?after=${activityCursorRef.current}`);
        const payload = await response.json();
        if (cancelled) return;
        activityCursorRef.current = payload.cursor;
        const events = Array.isArray(payload.events) ? payload.events : [];
        if (!events.length) return;
        const statusChanges = new Map();
        for (const event of events) {
          const ownerThreadId = eventThreadId(event);
          if (!ownerThreadId) continue;
          if (event.method === 'turn/started') statusChanges.set(ownerThreadId, 'active');
          if (event.method === 'turn/completed') statusChanges.set(ownerThreadId, 'idle');
          if (ownerThreadId !== selectedThreadRef.current) continue;
          if (event.method === 'turn/started' && event.params?.turn?.id) {
            setActiveTurnId(event.params.turn.id);
            setBusy(true);
          }
          if (event.method === 'turn/completed') {
            const completedTurnId = event.params?.turn?.id || null;
            setActiveTurnId((current) => !completedTurnId || current === completedTurnId ? null : current);
            setBusy(false);
          }
        }
        if (statusChanges.size) {
          const timestamp = Math.floor(Date.now() / 1000);
          setThreads((current) => current.map((thread) => statusChanges.has(thread.id)
            ? {
              ...thread,
              status: statusChanges.get(thread.id),
              ...(statusChanges.get(thread.id) === 'idle'
                ? { updatedAt: timestamp, recencyAt: timestamp }
                : {})
            }
            : thread));
        }
      } catch {
        // The selected-thread poll surfaces connection errors. This poll only
        // keeps background activity badges current.
      } finally {
        pending = false;
      }
    };
    pollActivity();
    const timer = window.setInterval(pollActivity, 900);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [usable]);

  useEffect(() => {
    if (!threadId) return undefined;
    let cancelled = false;
    let pending = false;
    const poll = async () => {
      if (pending || cancelled) return;
      pending = true;
      try {
        const response = await apiFetch(
          `/api/codex/events?after=${cursorRef.current}&threadId=${encodeURIComponent(threadId)}`
        );
        const payload = await response.json();
        if (cancelled || selectedThreadRef.current !== threadId) return;
        cursorRef.current = payload.cursor;
        if (payload.events && payload.events.length) {
          setEntries((current) => applyEvents(current, payload.events));
          for (const event of payload.events) {
            if (event.method === 'turn/started' && event.params && event.params.turn) {
              setActiveTurnId(event.params.turn.id);
              setBusy(true);
            }
            if (event.method === 'turn/completed') {
              setActiveTurnId(null);
              setBusy(false);
              setThreads((current) => current.map((thread) => (
                thread.id === threadId
                  ? { ...thread, updatedAt: Math.floor(Date.now() / 1000), recencyAt: Math.floor(Date.now() / 1000), status: 'idle' }
                  : thread
              )));
            }
          }
        }
      } catch (requestError) {
        if (!cancelled && selectedThreadRef.current === threadId) setError(requestError.message);
      } finally {
        pending = false;
      }
    };
    poll();
    const timer = window.setInterval(poll, 700);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [threadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries, busy]);

  const chooseModel = (model) => {
    const nextModel = models.find((entry) => entry.model === model);
    if (!nextModel) return;
    const efforts = Array.isArray(nextModel.supportedReasoningEfforts)
      ? nextModel.supportedReasoningEfforts
      : [];
    const nextEffort = efforts.includes(reasoningEffort)
      ? reasoningEffort
      : nextModel.defaultReasoningEffort || efforts[0] || '';
    setSelectedModel(nextModel.model);
    setReasoningEffort(nextEffort);
    savePreference(MODEL_STORAGE_KEY, nextModel.model);
    if (nextEffort) savePreference(REASONING_STORAGE_KEY, nextEffort);
  };

  const chooseReasoningEffort = (effort) => {
    if (!selectedModelDetails?.supportedReasoningEfforts?.includes(effort)) return;
    setReasoningEffort(effort);
    savePreference(REASONING_STORAGE_KEY, effort);
  };

  const chooseApprovalPolicy = (policy) => {
    if (![DEFAULT_APPROVAL_POLICY, NO_APPROVAL_POLICY].includes(policy)) return;
    setApprovalPolicy(policy);
    savePreference(APPROVAL_POLICY_STORAGE_KEY, policy);
  };

  const newThreadRequestBody = () => JSON.stringify({
    model: selectedModel,
    reasoningEffort,
    approvalPolicy
  });

  const startConversation = () => {
    if (resumingThreadId || startingTurn) return;
    selectedThreadRef.current = null;
    setThreadId(null);
    setActiveTurnId(null);
    setActiveModel('');
    setActiveReasoningEffort('');
    setActiveApprovalPolicy('');
    setEntries([]);
    setPrompt('');
    setBusy(false);
    setSteering(false);
    setError(null);
    cursorRef.current = 0;
    removePreference(ACTIVE_THREAD_STORAGE_KEY);
    if (mobileViewport()) setSidebarOpen(false);
  };

  const submitPrompt = async () => {
    const text = prompt.trim();
    if (!text || resumingThreadId || startingTurn || steering) return;
    if (busy && threadId && activeTurnId) {
      const optimisticId = `user:steer:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      setPrompt('');
      setSteering(true);
      setError(null);
      setEntries((current) => [...current, {
        id: optimisticId,
        type: 'user',
        text,
        delivery: 'pending'
      }]);
      try {
        await apiFetch(
          `/api/codex/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(activeTurnId)}/steer`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
          }
        );
        setEntries((current) => current.map((entry) => entry.id === optimisticId
          ? { ...entry, delivery: 'accepted' }
          : entry));
      } catch (requestError) {
        setEntries((current) => current.map((entry) => entry.id === optimisticId
          ? { ...entry, delivery: 'failed' }
          : entry));
        setError(requestError.message);
      } finally {
        setSteering(false);
      }
      return;
    }
    if (busy) return;
    let currentThread = threadId;
    const optimisticId = `user:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    setPrompt('');
    setBusy(true);
    setStartingTurn(true);
    setError(null);
    setEntries((current) => [...current, {
      id: optimisticId,
      type: 'user',
      text
    }]);
    try {
      if (!currentThread) {
        if (!selectionReady) throw new Error('Önce model ve reasoning seviyesini seçin.');
        const threadResponse = await apiFetch('/api/codex/threads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: newThreadRequestBody()
        });
        const threadPayload = await threadResponse.json();
        currentThread = threadPayload.thread.id;
        selectedThreadRef.current = currentThread;
        setThreadId(currentThread);
        setActiveModel(threadPayload.model || selectedModel);
        setActiveReasoningEffort(threadPayload.reasoningEffort || reasoningEffort);
        setActiveApprovalPolicy(threadPayload.approvalPolicy || approvalPolicy);
        savePreference(ACTIVE_THREAD_STORAGE_KEY, currentThread);
        cursorRef.current = 0;
        const optimisticThread = {
          ...threadPayload.thread,
          preview: text,
          updatedAt: Math.floor(Date.now() / 1000),
          recencyAt: Math.floor(Date.now() / 1000),
          status: 'active'
        };
        setThreads((current) => [optimisticThread, ...current.filter((thread) => thread.id !== currentThread)]);
      }
      const response = await apiFetch(`/api/codex/threads/${encodeURIComponent(currentThread)}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, approvalPolicy })
      });
      const payload = await response.json();
      if (selectedThreadRef.current === currentThread) {
        setActiveTurnId(payload.turn && payload.turn.id || null);
        setActiveApprovalPolicy(payload.approvalPolicy || approvalPolicy);
        setBusy(true);
      }
      setThreads((current) => current.map((thread) => (
        thread.id === currentThread
          ? { ...thread, preview: thread.preview || text, updatedAt: Math.floor(Date.now() / 1000), recencyAt: Math.floor(Date.now() / 1000), status: 'active' }
          : thread
      )));
    } catch (requestError) {
      if (!currentThread || selectedThreadRef.current === currentThread) {
        setBusy(false);
        setEntries((current) => [...current, {
          id: `error:${Date.now()}`,
          type: 'error',
          text: requestError.message
        }]);
      }
    } finally {
      setStartingTurn(false);
    }
  };

  const interrupt = async () => {
    if (!threadId || !activeTurnId) return;
    try {
      await apiFetch(
        `/api/codex/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(activeTurnId)}/interrupt`,
        { method: 'POST' }
      );
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const resolveApproval = async (entry, decision) => {
    try {
      await apiFetch(`/api/codex/approvals/${encodeURIComponent(entry.requestId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision })
      });
      setEntries((current) => current.map((candidate) => (
        candidate.id === entry.id ? { ...candidate, resolved: true, decision } : candidate
      )));
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const effectiveApprovalPolicy = activeApprovalPolicy || approvalPolicy;
  const statusLabel = useMemo(() => {
    if (!connection) return '';
    if (!connection.installed) return 'Kurulu değil';
    if (!connection.connected) return 'Hesap bağlı değil';
    if (!connection.fullServer) return 'Salt okunur';
    return 'Sunucuya bağlı';
  }, [connection]);
  const canSubmit = Boolean(prompt.trim()) && !resumingThreadId && !startingTurn && !steering && (
    busy
      ? Boolean(threadId && activeTurnId)
      : Boolean(threadId || selectionReady)
  );
  const activeModelLabel = models.find((entry) => entry.model === activeModel)?.displayName || activeModel;

  if (loading) {
    return (
      <div className="codex-shell">
        <div className="codex-loading"><Loader2 size={18} className="spin" /></div>
      </div>
    );
  }

  return (
    <div className="codex-shell">
      <header className="codex-topbar">
        <div className="codex-brand">
          <button
            type="button"
            onClick={() => setSidebarOpen((current) => !current)}
            disabled={!usable}
            title={sidebarOpen ? 'Konuşma geçmişini gizle' : 'Konuşma geçmişini göster'}
            aria-label={sidebarOpen ? 'Konuşma geçmişini gizle' : 'Konuşma geçmişini göster'}
            className="codex-icon-button"
          >
            {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </button>
          <div className="codex-brand-mark"><Bot size={16} /></div>
          <div className="codex-brand-copy">
            <div className="codex-brand-title">Codex</div>
            <div className="codex-brand-status">{statusLabel}</div>
          </div>
        </div>
        <div className="codex-top-actions">
          <button
            type="button"
            onClick={startConversation}
            disabled={!usable || Boolean(resumingThreadId) || startingTurn}
            className="codex-secondary-button"
            title="Yeni konuşma"
          >
            <Plus size={14} /> <span>Yeni konuşma</span>
          </button>
          <button type="button" onClick={openConnections} className="codex-secondary-button">
            <Settings size={14} /> <span>Bağlantı</span>
          </button>
        </div>
      </header>

      {!usable ? (
        <div className="codex-gate">
          <div className="codex-gate-card">
            <ShieldAlert size={28} color="#f6c453" />
            <h3>Full Server bağlantısı gerekli</h3>
            <p>
              Codex CLI’ı kurun, kendi ChatGPT hesabınızı bağlayın ve Full Server erişimini açıkça etkinleştirin.
            </p>
            <button type="button" onClick={openConnections} className="codex-secondary-button">
              <Settings size={14} /> Bağlantılar’a Git
            </button>
          </div>
        </div>
      ) : (
        <div className="codex-workspace">
          {sidebarOpen && (
            <>
              <button
                type="button"
                className="codex-sidebar-backdrop"
                aria-label="Konuşma geçmişini kapat"
                onClick={() => setSidebarOpen(false)}
              />
              <aside className="codex-sidebar">
              <div className="codex-sidebar-top">
                <button
                  type="button"
                  onClick={startConversation}
                  disabled={Boolean(resumingThreadId) || startingTurn}
                  className="codex-new-chat"
                >
                  <Plus size={14} /> Yeni konuşma
                </button>
              </div>
              <div className="codex-sidebar-heading">
                <History size={14} />
                <span>Konuşmalar</span>
                <button
                  type="button"
                  onClick={refreshThreads}
                  disabled={threadsLoading}
                  title="Geçmişi yenile"
                  aria-label="Konuşma geçmişini yenile"
                >
                  <RefreshCw size={13} className={threadsLoading ? 'spin' : ''} />
                </button>
              </div>
              <div className="codex-thread-list">
                {threadsLoading && !threads.length ? (
                  <div className="codex-sidebar-message"><Loader2 size={13} className="spin" /> Geçmiş yükleniyor</div>
                ) : !threads.length ? (
                  <div className="codex-sidebar-message">Henüz kayıtlı konuşma yok.</div>
                ) : threads.map((thread) => {
                  const active = thread.id === threadId;
                  const resuming = thread.id === resumingThreadId;
                  const running = thread.status === 'active';
                  return (
                    <button
                      key={thread.id}
                      type="button"
                      onClick={() => resumeConversation(thread.id)}
                      disabled={Boolean(resumingThreadId) || startingTurn}
                      aria-current={active ? 'page' : undefined}
                      title={threadTitle(thread)}
                      className={`codex-thread-row${active ? ' is-selected' : ''}`}
                    >
                      <span className={`codex-thread-dot${running ? ' is-running' : ''}`} aria-hidden="true" />
                      <div className="codex-thread-copy">
                        <div className="codex-thread-title">{threadTitle(thread)}</div>
                        {(running || resuming) && <div className="codex-thread-state">{resuming ? 'Açılıyor…' : 'Çalışıyor'}</div>}
                      </div>
                      {resuming ? <Loader2 size={12} className="spin" /> : <span className="codex-thread-time">{threadTime(thread)}</span>}
                    </button>
                  );
                })}
                {nextThreadCursor && (
                  <button type="button" onClick={loadMoreThreads} disabled={loadingMoreThreads} className="codex-load-more">
                    {loadingMoreThreads && <Loader2 size={12} className="spin" />} Daha fazla
                  </button>
                )}
                {historyError && <div className="codex-sidebar-message is-error">{historyError}</div>}
              </div>
              </aside>
            </>
          )}

          <section className="codex-main">
            <div className="codex-config-row">
              {threadId ? (
                <div className="codex-thread-meta">
                  <Bot size={12} />
                  <span>{activeModelLabel || 'Codex'} · {REASONING_LABELS[activeReasoningEffort] || activeReasoningEffort || '—'}</span>
                </div>
              ) : (
                <>
                  <label className="codex-config-field">
                    <span>Model</span>
                    <select aria-label="Codex modeli" value={selectedModel} onChange={(event) => chooseModel(event.target.value)} disabled={modelsLoading || !models.length}>
                      {models.map((model) => <option key={model.model} value={model.model}>{model.displayName}</option>)}
                    </select>
                  </label>
                  <label className="codex-config-field">
                    <span>Reasoning</span>
                    <select aria-label="Codex reasoning seviyesi" value={reasoningEffort} onChange={(event) => chooseReasoningEffort(event.target.value)} disabled={modelsLoading || !selectedModelDetails}>
                      {(selectedModelDetails?.supportedReasoningEfforts || []).map((effort) => <option key={effort} value={effort}>{REASONING_LABELS[effort] || effort}</option>)}
                    </select>
                  </label>
                </>
              )}
              <label className={`codex-config-field is-permission${approvalPolicy === NO_APPROVAL_POLICY ? ' is-unrestricted' : ''}`}>
                <ShieldCheck size={12} /> <span>İzinler</span>
                <select aria-label="Codex izin politikası" value={approvalPolicy} onChange={(event) => chooseApprovalPolicy(event.target.value)} disabled={busy || Boolean(resumingThreadId)}>
                  <option value={DEFAULT_APPROVAL_POLICY}>Gerektiğinde sor</option>
                  <option value={NO_APPROVAL_POLICY}>Tam Erişim — sorma</option>
                </select>
              </label>
            </div>

            <div className="codex-conversation">
              {resumingThreadId && !entries.length ? (
                <div className="codex-empty-state"><div className="codex-agent-loading"><Loader2 size={15} className="spin" /> Konuşma açılıyor…</div></div>
              ) : !entries.length ? (
                <div className="codex-empty-state">
                  <div>
                    <div className="codex-empty-mark"><Bot size={19} /></div>
                    <div className="codex-empty-title">{threadId ? 'Bu konuşmaya devam edebilirsin' : 'Sunucuda ne yapmak istersin?'}</div>
                    <div className="codex-empty-copy">
                      {threadId
                        ? connection.memoryEnabled
                          ? 'Geçmiş ve kişisel hafıza bu konuşma için hazır.'
                          : 'Geçmiş konuşma sunucudaki Codex kaydından açıldı.'
                        : connection.memoryEnabled
                          ? 'Dosyalar, servisler ve hafızan bu konuşmada kullanılabilir.'
                          : 'Dosyalar, Docker, systemd, servisler ve paketler dahil.'}
                    </div>
                  </div>
                </div>
              ) : null}

              {!!entries.length && <div className="codex-thread-column">
              <div className="codex-entry-list">
                {entries.map((entry) => {
                  if (entry.type === 'user') {
                    return (
                      <div key={entry.id} className="codex-user-message">
                        {entry.text}
                        {entry.delivery && (
                          <div className={`codex-user-delivery${entry.delivery === 'failed' ? ' is-failed' : ''}`}>
                            {entry.delivery === 'pending' ? 'Çalışan isteğe ekleniyor…' : entry.delivery === 'accepted' ? 'Çalışan isteğe eklendi' : 'Eklenemedi'}
                          </div>
                        )}
                      </div>
                    );
                  }
                  if (entry.type === 'agent') {
                    return (
                      <div key={entry.id} className="codex-agent-message">
                        {entry.text
                          ? <CodexMarkdown onOpenLocalFile={openLocalFile}>{entry.text}</CodexMarkdown>
                          : <div className="codex-agent-loading"><Loader2 size={14} className="spin" /> Yanıt hazırlanıyor…</div>}
                      </div>
                    );
                  }
                  if (entry.type === 'command') {
                    return (
                      <div key={entry.id} className="codex-command-card">
                        <div className="codex-command-title">
                          <TerminalSquare size={13} /> <code>{entry.command || 'Komut çalışıyor'}</code>
                          <span>{entry.status}</span>
                        </div>
                        {entry.output && <pre className="codex-command-output">{entry.output}</pre>}
                      </div>
                    );
                  }
                  if (entry.type === 'file') {
                    return <div key={entry.id} className="codex-file-change"><Code2 size={14} />{entry.text}</div>;
                  }
                  if (entry.type === 'approval') {
                    const canAcceptSession = !entry.availableDecisions || entry.availableDecisions.includes('acceptForSession');
                    return (
                      <div key={entry.id} className="codex-approval-card">
                        <div className="codex-approval-title"><ShieldAlert size={15} /> Codex onay istiyor</div>
                        {entry.reason && <div className="codex-approval-reason">{entry.reason}</div>}
                        {entry.command && <pre className="codex-approval-command">{entry.command}</pre>}
                        {entry.resolved ? (
                          <div className="codex-approval-reason">{entry.decision.startsWith('accept') ? 'Onaylandı' : 'Reddedildi'}</div>
                        ) : (
                          <div className="codex-approval-actions">
                            <button type="button" onClick={() => resolveApproval(entry, 'accept')} className="is-accept"><Check size={13} /> Bir kez onayla</button>
                            {canAcceptSession && <button type="button" onClick={() => resolveApproval(entry, 'acceptForSession')}>Bu oturumda onayla</button>}
                            <button type="button" onClick={() => resolveApproval(entry, 'decline')}><X size={13} /> Reddet</button>
                          </div>
                        )}
                      </div>
                    );
                  }
                  return <div key={entry.id} className={`codex-inline-notice${entry.type === 'error' ? ' is-error' : ''}`}>{entry.text}</div>;
                })}
                {busy && (
                  <div className="codex-working">
                    <span className="codex-working-dots" aria-hidden="true"><i /><i /><i /></span>
                    Codex çalışıyor
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
              </div>}
            </div>

            <div className="codex-composer-wrap">
              <div className="codex-composer-column">
              {error && <div className="codex-composer-error">{error}</div>}
              <div className={`codex-composer${effectiveApprovalPolicy === NO_APPROVAL_POLICY ? ' is-unrestricted' : ''}`}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      submitPrompt();
                    }
                  }}
                  disabled={Boolean(resumingThreadId)}
                  placeholder={busy ? 'Çalışan isteğe bir şey ekle…' : 'Sunucuda ne yapmamı istersin?'}
                  aria-label={busy ? 'Çalışan Codex isteğine mesaj ekle' : 'Codex’e mesaj gönder'}
                  rows={2}
                />
                <div className="codex-composer-footer">
                  <div className="codex-composer-status">
                    <span className={`codex-status-dot${busy ? ' is-running' : ''}`} aria-hidden="true" />
                    <span>{busy
                      ? steering ? 'Mesaj ekleniyor…' : 'Codex çalışıyor · Yeni mesaj bu işe eklenir'
                      : threadId ? 'Bu konuşmaya devam et' : `${selectedModelDetails?.displayName || 'Codex'} · ${REASONING_LABELS[reasoningEffort] || reasoningEffort}`}</span>
                  </div>
                  <div className="codex-composer-actions">
                    {busy && activeTurnId && (
                      <button type="button" onClick={interrupt} title="Çalışmayı durdur" aria-label="Çalışmayı durdur" className="codex-stop-button"><CircleStop size={15} /></button>
                    )}
                    <button
                      type="button"
                      onClick={submitPrompt}
                      disabled={!canSubmit}
                      title={busy ? 'Çalışan isteğe ekle' : 'Gönder'}
                      aria-label={busy ? 'Çalışan isteğe ekle' : 'Gönder'}
                      className={`codex-send-button${busy ? ' is-steer' : ''}`}
                    >
                      {startingTurn || steering ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
                    </button>
                  </div>
                </div>
              </div>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};

export default CodexApp;
