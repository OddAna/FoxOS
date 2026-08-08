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

const BUTTON_STYLE = {
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: '8px',
  color: '#fff',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '7px',
  fontSize: '12px',
  padding: '8px 11px'
};

const SELECT_STYLE = {
  minWidth: '150px',
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: '7px',
  background: 'rgba(255,255,255,0.07)',
  color: '#fff',
  fontSize: '12px',
  padding: '7px 28px 7px 9px',
  outline: 'none'
};

const MODEL_STORAGE_KEY = 'foxos.codex.model';
const REASONING_STORAGE_KEY = 'foxos.codex.reasoning-effort';
const APPROVAL_POLICY_STORAGE_KEY = 'foxos.codex.approval-policy';
const ACTIVE_THREAD_STORAGE_KEY = 'foxos.codex.active-thread';
const DEFAULT_APPROVAL_POLICY = 'untrusted';
const NO_APPROVAL_POLICY = 'never';
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [historyError, setHistoryError] = useState(null);
  const cursorRef = useRef(0);
  const bottomRef = useRef(null);
  const autoResumeAttemptedRef = useRef(false);
  const resumeConversationRef = useRef(null);

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
    if (!selectedThreadId || busy || resumingThreadId) return;
    setResumingThreadId(selectedThreadId);
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
      if (storedPreference(ACTIVE_THREAD_STORAGE_KEY) === selectedThreadId) {
        removePreference(ACTIVE_THREAD_STORAGE_KEY);
      }
      setError(requestError.message);
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
        if (cancelled) return;
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
        if (!cancelled) setError(requestError.message);
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
    if (busy) return;
    setThreadId(null);
    setActiveTurnId(null);
    setActiveModel('');
    setActiveReasoningEffort('');
    setActiveApprovalPolicy('');
    setEntries([]);
    setPrompt('');
    setError(null);
    cursorRef.current = 0;
    removePreference(ACTIVE_THREAD_STORAGE_KEY);
  };

  const submitPrompt = async () => {
    const text = prompt.trim();
    if (!text || busy || resumingThreadId) return;
    let currentThread = threadId;
    setPrompt('');
    setBusy(true);
    setError(null);
    setEntries((current) => [...current, {
      id: `user:${Date.now()}`,
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
      setActiveTurnId(payload.turn && payload.turn.id || null);
      setActiveApprovalPolicy(payload.approvalPolicy || approvalPolicy);
      setThreads((current) => current.map((thread) => (
        thread.id === currentThread
          ? { ...thread, preview: thread.preview || text, updatedAt: Math.floor(Date.now() / 1000), recencyAt: Math.floor(Date.now() / 1000), status: 'active' }
          : thread
      )));
    } catch (requestError) {
      setBusy(false);
      setEntries((current) => [...current, {
        id: `error:${Date.now()}`,
        type: 'error',
        text: requestError.message
      }]);
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
    return `Full Server · / · ${effectiveApprovalPolicy === NO_APPROVAL_POLICY ? 'İzin sorma' : 'Onaylı'}`;
  }, [connection, effectiveApprovalPolicy]);

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#888' }}>
        <Loader2 size={18} className="spin" />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'rgba(20,20,24,0.96)', color: '#fff', minWidth: 0 }}>
      <div style={{ padding: '11px 14px', borderBottom: '1px solid rgba(255,255,255,0.09)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px', minWidth: 0 }}>
          <button
            type="button"
            onClick={() => setSidebarOpen((current) => !current)}
            disabled={!usable}
            title={sidebarOpen ? 'Konuşma geçmişini gizle' : 'Konuşma geçmişini göster'}
            aria-label={sidebarOpen ? 'Konuşma geçmişini gizle' : 'Konuşma geçmişini göster'}
            style={{ ...BUTTON_STYLE, width: '32px', height: '32px', padding: 0, background: 'rgba(255,255,255,0.05)', cursor: usable ? 'pointer' : 'not-allowed', opacity: usable ? 1 : 0.45 }}
          >
            {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </button>
          <Bot size={19} color={usable ? '#75da85' : '#aaa'} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 700 }}>Codex</div>
            <div style={{ color: usable ? '#75da85' : '#888', fontSize: '11px', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{statusLabel}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="button" onClick={startConversation} disabled={!usable || busy || Boolean(resumingThreadId)} style={{ ...BUTTON_STYLE, background: 'rgba(255,255,255,0.07)', cursor: !usable || busy || resumingThreadId ? 'not-allowed' : 'pointer', opacity: !usable || busy || resumingThreadId ? 0.45 : 1 }}>
            <Plus size={14} /> Yeni Konuşma
          </button>
          <button type="button" onClick={openConnections} style={{ ...BUTTON_STYLE, background: 'rgba(255,255,255,0.07)', cursor: 'pointer' }}>
            <Settings size={14} /> Bağlantı
          </button>
        </div>
      </div>

      {!usable ? (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: '24px' }}>
          <div style={{ maxWidth: '480px', padding: '20px', borderRadius: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', textAlign: 'center' }}>
            <ShieldAlert size={28} color="#f6c453" />
            <h3 style={{ fontSize: '16px', margin: '12px 0 8px' }}>Full Server bağlantısı gerekli</h3>
            <p style={{ color: '#aaa', fontSize: '13px', lineHeight: 1.55, margin: '0 0 14px' }}>
              Codex CLI’ı kurun, kendi ChatGPT hesabınızı bağlayın ve Full Server erişimini açıkça etkinleştirin.
            </p>
            <button type="button" onClick={openConnections} style={{ ...BUTTON_STYLE, background: '#0ea5e9', border: 'none', cursor: 'pointer', fontWeight: 700 }}>
              <Settings size={14} /> Bağlantılar’a Git
            </button>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0 }}>
          {sidebarOpen && (
            <aside style={{ width: 'clamp(190px, 25%, 240px)', flex: '0 0 clamp(190px, 25%, 240px)', display: 'flex', flexDirection: 'column', minHeight: 0, borderRight: '1px solid rgba(255,255,255,0.09)', background: 'rgba(0,0,0,0.16)' }}>
              <div style={{ height: '45px', padding: '0 10px 0 12px', display: 'flex', alignItems: 'center', gap: '7px', borderBottom: '1px solid rgba(255,255,255,0.07)', color: '#bbb' }}>
                <History size={14} />
                <span style={{ fontSize: '12px', fontWeight: 700 }}>Konuşmalar</span>
                <button
                  type="button"
                  onClick={refreshThreads}
                  disabled={threadsLoading}
                  title="Geçmişi yenile"
                  aria-label="Konuşma geçmişini yenile"
                  style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: '#999', display: 'grid', placeItems: 'center', cursor: threadsLoading ? 'wait' : 'pointer', padding: '5px' }}
                >
                  <RefreshCw size={13} className={threadsLoading ? 'spin' : ''} />
                </button>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px' }}>
                {threadsLoading && !threads.length ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px', padding: '20px 8px', color: '#777', fontSize: '11px' }}><Loader2 size={13} className="spin" /> Geçmiş yükleniyor</div>
                ) : !threads.length ? (
                  <div style={{ padding: '18px 10px', color: '#777', fontSize: '11px', lineHeight: 1.5, textAlign: 'center' }}>Henüz kayıtlı konuşma yok.</div>
                ) : threads.map((thread) => {
                  const active = thread.id === threadId;
                  const resuming = thread.id === resumingThreadId;
                  return (
                    <button
                      key={thread.id}
                      type="button"
                      onClick={() => resumeConversation(thread.id)}
                      disabled={busy || Boolean(resumingThreadId)}
                      aria-current={active ? 'page' : undefined}
                      title={threadTitle(thread)}
                      style={{ width: '100%', display: 'block', border: `1px solid ${active ? 'rgba(14,165,233,0.38)' : 'transparent'}`, background: active ? 'rgba(14,165,233,0.13)' : 'transparent', color: active ? '#fff' : '#bbb', borderRadius: '8px', padding: '9px 10px', marginBottom: '3px', textAlign: 'left', cursor: busy || resumingThreadId ? 'not-allowed' : 'pointer', opacity: busy && !active ? 0.55 : 1 }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', fontWeight: active ? 700 : 500 }}>{threadTitle(thread)}</span>
                        {resuming ? <Loader2 size={12} className="spin" /> : <span style={{ color: '#666', fontSize: '10px', whiteSpace: 'nowrap' }}>{threadTime(thread)}</span>}
                      </div>
                    </button>
                  );
                })}
                {nextThreadCursor && (
                  <button type="button" onClick={loadMoreThreads} disabled={loadingMoreThreads} style={{ ...BUTTON_STYLE, width: '100%', marginTop: '7px', background: 'rgba(255,255,255,0.04)', color: '#aaa', cursor: loadingMoreThreads ? 'wait' : 'pointer' }}>
                    {loadingMoreThreads && <Loader2 size={12} className="spin" />} Daha fazla
                  </button>
                )}
                {historyError && <div style={{ color: '#ff8a84', fontSize: '11px', lineHeight: 1.45, padding: '9px' }}>{historyError}</div>}
              </div>
            </aside>
          )}

          <section style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '9px 14px', borderBottom: '1px solid rgba(255,255,255,0.09)', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '7px', color: '#aaa', fontSize: '11px' }}>
                Model
                <select aria-label="Codex modeli" value={selectedModel} onChange={(event) => chooseModel(event.target.value)} disabled={modelsLoading || busy || !models.length} style={{ ...SELECT_STYLE, opacity: modelsLoading || busy ? 0.5 : 1 }}>
                  {models.map((model) => <option key={model.model} value={model.model}>{model.displayName}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '7px', color: '#aaa', fontSize: '11px' }}>
                Reasoning
                <select aria-label="Codex reasoning seviyesi" value={reasoningEffort} onChange={(event) => chooseReasoningEffort(event.target.value)} disabled={modelsLoading || busy || !selectedModelDetails} style={{ ...SELECT_STYLE, minWidth: '110px', opacity: modelsLoading || busy ? 0.5 : 1 }}>
                  {(selectedModelDetails?.supportedReasoningEfforts || []).map((effort) => <option key={effort} value={effort}>{REASONING_LABELS[effort] || effort}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '7px', color: approvalPolicy === NO_APPROVAL_POLICY ? '#f6c453' : '#aaa', fontSize: '11px' }}>
                <ShieldCheck size={13} /> İzinler
                <select aria-label="Codex izin politikası" value={approvalPolicy} onChange={(event) => chooseApprovalPolicy(event.target.value)} disabled={busy || Boolean(resumingThreadId)} style={{ ...SELECT_STYLE, minWidth: '154px', borderColor: approvalPolicy === NO_APPROVAL_POLICY ? 'rgba(246,196,83,0.4)' : 'rgba(255,255,255,0.14)', opacity: busy || resumingThreadId ? 0.5 : 1 }}>
                  <option value={DEFAULT_APPROVAL_POLICY}>Gerektiğinde sor</option>
                  <option value={NO_APPROVAL_POLICY}>Tam Erişim — sorma</option>
                </select>
              </label>
              <div style={{ color: approvalPolicy === NO_APPROVAL_POLICY ? '#d9b85f' : '#777', fontSize: '11px', lineHeight: 1.35 }}>
                {modelsLoading
                  ? 'Modeller yükleniyor...'
                  : approvalPolicy === NO_APPROVAL_POLICY
                    ? 'Sonraki istekte komut ve dosya değişiklikleri için onay istenmez.'
                    : threadId && activeModel
                      ? `Aktif: ${activeModel} · ${REASONING_LABELS[activeReasoningEffort] || activeReasoningEffort}. Model değişikliği yeni konuşmada uygulanır.`
                      : 'Yeni konuşma ayarları'}
              </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
              {resumingThreadId && !entries.length ? (
                <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', color: '#888', fontSize: '12px' }}><div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Loader2 size={15} className="spin" /> Konuşma açılıyor...</div></div>
              ) : !entries.length ? (
                <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', color: '#777', textAlign: 'center' }}>
                  <div>
                    <Bot size={34} style={{ marginBottom: '10px' }} />
                    <div style={{ fontSize: '14px', color: '#aaa' }}>{threadId ? 'Bu konuşmaya devam edebilirsiniz.' : 'Codex bütün Linux sunucusunda çalışmaya hazır.'}</div>
                    <div style={{ fontSize: '12px', marginTop: '5px' }}>
                      {threadId
                        ? connection.memoryEnabled
                          ? 'Geçmiş konuşma açıldı; Drive hafızası bu oturum için yeniden yüklenecek.'
                          : 'Geçmiş konuşma sunucudaki Codex kaydından açıldı.'
                        : connection.memoryEnabled
                          ? 'Drive hafızası ilk mesajdan önce otomatik yüklenir.'
                          : 'Dosyalar, Docker, systemd, servisler ve paketler dahil.'}
                    </div>
                  </div>
                </div>
              ) : null}

              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {entries.map((entry) => {
                  if (entry.type === 'user') {
                    return <div key={entry.id} style={{ alignSelf: 'flex-end', maxWidth: '78%', background: '#0b6fa4', padding: '10px 12px', borderRadius: '12px 12px 3px 12px', fontSize: '13px', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{entry.text}</div>;
                  }
                  if (entry.type === 'agent') {
                    return <div key={entry.id} style={{ maxWidth: '88%', color: '#e5e5e5', fontSize: '13px', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{entry.text || <Loader2 size={14} className="spin" />}</div>;
                  }
                  if (entry.type === 'command') {
                    return (
                      <div key={entry.id} style={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', background: 'rgba(0,0,0,0.28)', overflow: 'hidden' }}>
                        <div style={{ padding: '8px 10px', display: 'flex', gap: '8px', alignItems: 'center', borderBottom: entry.output ? '1px solid rgba(255,255,255,0.08)' : 'none', color: '#aaa', fontSize: '11px' }}>
                          <TerminalSquare size={13} /> <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: '#ddd' }}>{entry.command || 'Komut çalışıyor'}</span>
                          <span style={{ marginLeft: 'auto' }}>{entry.status}</span>
                        </div>
                        {entry.output && <pre style={{ margin: 0, padding: '10px', maxHeight: '260px', overflow: 'auto', whiteSpace: 'pre-wrap', color: '#bbb', fontSize: '11px', lineHeight: 1.45 }}>{entry.output}</pre>}
                      </div>
                    );
                  }
                  if (entry.type === 'file') {
                    return <div key={entry.id} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', color: '#b9dfc0', fontSize: '12px', whiteSpace: 'pre-wrap' }}><Code2 size={14} style={{ marginTop: 2 }} />{entry.text}</div>;
                  }
                  if (entry.type === 'approval') {
                    const canAcceptSession = !entry.availableDecisions || entry.availableDecisions.includes('acceptForSession');
                    return (
                      <div key={entry.id} style={{ border: '1px solid rgba(246,196,83,0.35)', background: 'rgba(246,196,83,0.08)', borderRadius: '10px', padding: '12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#f6c453', fontWeight: 700, fontSize: '13px' }}><ShieldAlert size={15} /> Codex onay istiyor</div>
                        {entry.reason && <div style={{ color: '#bbb', fontSize: '12px', marginTop: '8px' }}>{entry.reason}</div>}
                        {entry.command && <pre style={{ whiteSpace: 'pre-wrap', margin: '9px 0 0', padding: '9px', borderRadius: '7px', background: 'rgba(0,0,0,0.3)', color: '#eee', fontSize: '11px' }}>{entry.command}</pre>}
                        {entry.resolved ? (
                          <div style={{ marginTop: '9px', color: entry.decision.startsWith('accept') ? '#75da85' : '#aaa', fontSize: '12px' }}>{entry.decision.startsWith('accept') ? 'Onaylandı' : 'Reddedildi'}</div>
                        ) : (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' }}>
                            <button type="button" onClick={() => resolveApproval(entry, 'accept')} style={{ ...BUTTON_STYLE, background: '#238636', border: 'none', cursor: 'pointer' }}><Check size={13} /> Bir Kez Onayla</button>
                            {canAcceptSession && <button type="button" onClick={() => resolveApproval(entry, 'acceptForSession')} style={{ ...BUTTON_STYLE, background: 'rgba(255,255,255,0.08)', cursor: 'pointer' }}>Bu Oturumda Onayla</button>}
                            <button type="button" onClick={() => resolveApproval(entry, 'decline')} style={{ ...BUTTON_STYLE, background: 'transparent', cursor: 'pointer' }}><X size={13} /> Reddet</button>
                          </div>
                        )}
                      </div>
                    );
                  }
                  return <div key={entry.id} style={{ color: entry.type === 'error' ? '#ff8a84' : '#f6c453', fontSize: '12px' }}>{entry.text}</div>;
                })}
                {busy && <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: '#888', fontSize: '12px' }}><Loader2 size={13} className="spin" /> Codex çalışıyor...</div>}
                <div ref={bottomRef} />
              </div>
            </div>

            <div style={{ borderTop: '1px solid rgba(255,255,255,0.09)', padding: '12px' }}>
              {error && <div style={{ color: '#ff8a84', fontSize: '12px', marginBottom: '8px' }}>{error}</div>}
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px', borderRadius: '10px', background: 'rgba(255,255,255,0.06)', border: `1px solid ${approvalPolicy === NO_APPROVAL_POLICY ? 'rgba(246,196,83,0.3)' : 'rgba(255,255,255,0.12)'}`, padding: '8px' }}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      submitPrompt();
                    }
                  }}
                  disabled={busy || Boolean(resumingThreadId)}
                  placeholder="Sunucuda ne yapmamı istersin?"
                  rows={2}
                  style={{ flex: 1, resize: 'none', background: 'transparent', color: '#fff', border: 'none', outline: 'none', font: 'inherit', fontSize: '13px', lineHeight: 1.45, minHeight: '38px' }}
                />
                {busy && activeTurnId ? (
                  <button type="button" onClick={interrupt} title="Durdur" style={{ ...BUTTON_STYLE, width: '36px', height: '36px', padding: 0, background: 'rgba(255,95,86,0.15)', color: '#ff8a84', cursor: 'pointer' }}><CircleStop size={16} /></button>
                ) : (
                  <button type="button" onClick={submitPrompt} disabled={!prompt.trim() || Boolean(resumingThreadId) || (!threadId && !selectionReady)} title="Gönder" style={{ ...BUTTON_STYLE, width: '36px', height: '36px', padding: 0, background: '#0ea5e9', border: 'none', cursor: prompt.trim() && !resumingThreadId && (threadId || selectionReady) ? 'pointer' : 'not-allowed', opacity: prompt.trim() && !resumingThreadId && (threadId || selectionReady) ? 1 : 0.45 }}><Send size={16} /></button>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};

export default CodexApp;
