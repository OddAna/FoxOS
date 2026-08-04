import React, { useState, useRef, useEffect } from 'react';

const TerminalApp = () => {
  const [history, setHistory] = useState([
    { type: 'system', content: 'FoxOS Host Terminal' },
    { type: 'system', content: 'Komutlar doğrudan bağlı Linux sunucusunda root yetkisiyle çalışır.\n' }
  ]);
  const [input, setInput] = useState('');
  const [cwd, setCwd] = useState('/');
  const [commandHistory, setCommandHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isProcessing, setIsProcessing] = useState(false);
  
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [history]);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  const handleCommand = async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = input.trim();
      
      if (!cmd) {
        setHistory(prev => [...prev, { type: 'prompt', content: `root@foxos:${cwd}$ ` }]);
        return;
      }
      
      if (cmd === 'clear') {
        setHistory([]);
        setInput('');
        return;
      }

      setCommandHistory(prev => [...prev, cmd]);
      setHistoryIndex(-1);
      
      setHistory(prev => [...prev, { type: 'prompt', content: `root@foxos:${cwd}$ ${cmd}` }]);
      setInput('');
      setIsProcessing(true);

      try {
        const response = await fetch('/api/terminal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd, cwd: cwd })
        });
        
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Komut çalıştırılamadı');
        }
        
        if (data.cwd !== undefined) {
          setCwd(data.cwd);
        }
        
        if (data.output) {
          setHistory(prev => [...prev, { type: data.success === false ? 'error' : 'output', content: data.output }]);
        }
      } catch (err) {
        setHistory(prev => [...prev, { type: 'error', content: `Bağlantı hatası: ${err.message}` }]);
      } finally {
        setIsProcessing(false);
        setTimeout(() => inputRef.current?.focus(), 10);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const newIndex = historyIndex < commandHistory.length - 1 ? historyIndex + 1 : historyIndex;
        setHistoryIndex(newIndex);
        setInput(commandHistory[commandHistory.length - 1 - newIndex]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setInput(commandHistory[commandHistory.length - 1 - newIndex]);
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setInput('');
      }
    }
  };

  return (
    <div 
      style={{ 
        display: 'flex', flexDirection: 'column', height: '100%', width: '100%', 
        backgroundColor: 'rgba(30,30,30,0.95)', color: '#d4d4d4', 
        fontFamily: 'Consolas, Monaco, monospace', fontSize: '13px',
        padding: '16px', overflowY: 'auto'
      }}
      onClick={() => inputRef.current?.focus()}
    >
      {history.map((entry, idx) => (
        <div key={idx} style={{ marginBottom: entry.type === 'output' ? '12px' : '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {entry.type === 'prompt' && <span style={{ color: '#4ade80' }}>{entry.content.split('$')[0]}$</span>}
          {entry.type === 'prompt' && <span style={{ color: '#fff' }}>{entry.content.split('$')[1]}</span>}
          
          {entry.type === 'output' && <span>{entry.content}</span>}
          {entry.type === 'error' && <span style={{ color: '#f87171' }}>{entry.content}</span>}
          {entry.type === 'system' && <span style={{ color: '#60a5fa' }}>{entry.content}</span>}
        </div>
      ))}
      
      <div style={{ display: 'flex', alignItems: 'flex-start', marginTop: '4px' }}>
        <span style={{ color: '#4ade80', marginRight: '8px', whiteSpace: 'nowrap' }}>
          root@foxos:{cwd}$
        </span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleCommand}
          disabled={isProcessing}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck="false"
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            color: '#fff',
            fontFamily: 'inherit',
            fontSize: 'inherit',
            outline: 'none',
            padding: 0,
            margin: 0
          }}
        />
      </div>
      <div ref={bottomRef} />
    </div>
  );
};

export default TerminalApp;
