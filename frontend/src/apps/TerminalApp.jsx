import React, { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useWindowManager } from '../contexts/WindowContext';

const TERMINAL_SOCKET_PATH = '/api/terminal/socket';

function terminalSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${TERMINAL_SOCKET_PATH}`;
}

const TerminalApp = () => {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const { focusedWindowId } = useWindowManager();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    let disposed = false;
    let socket = null;
    let connected = false;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: 'Consolas, Monaco, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 10_000,
      allowTransparency: true,
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#ffffff',
        selectionBackground: '#264f78',
        black: '#1e1e1e',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#d4d4d4',
        brightBlack: '#737373',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde047',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#ffffff'
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    terminal.writeln('\x1b[94mFoxOS Host Terminal\x1b[0m');
    terminal.writeln('\x1b[94mDoğrudan bağlı Linux sunucusunda root yetkili, kalıcı PTY oturumu.\x1b[0m');
    terminal.writeln('');

    const send = (message) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(message));
    };

    const fit = () => {
      if (disposed || !container.isConnected) return;
      const bounds = container.getBoundingClientRect();
      if (bounds.width < 40 || bounds.height < 20) return;
      try {
        fitAddon.fit();
        send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
      } catch { /* The window may be between minimized and restored layouts. */ }
    };

    const inputSubscription = terminal.onData((data) => {
      send({ type: 'input', data });
    });

    try {
      socket = new WebSocket(terminalSocketUrl());
      socket.addEventListener('open', () => {
        if (disposed) return;
        connected = true;
        fit();
        terminal.focus();
      });
      socket.addEventListener('message', (event) => {
        if (disposed || typeof event.data !== 'string') return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'output' && typeof message.data === 'string') {
            terminal.write(message.data);
          } else if (message.type === 'error') {
            terminal.writeln(`\r\n\x1b[91m${message.message || 'Terminal başlatılamadı.'}\x1b[0m`);
          } else if (message.type === 'exit') {
            terminal.writeln(`\r\n\x1b[90m[PTY oturumu sona erdi: ${message.exitCode ?? 0}]\x1b[0m`);
          }
        } catch {
          terminal.writeln('\r\n\x1b[91mGeçersiz terminal yanıtı alındı.\x1b[0m');
        }
      });
      socket.addEventListener('close', () => {
        if (!disposed && connected) {
          terminal.writeln('\r\n\x1b[90m[Terminal bağlantısı kapandı. Yeniden açmak için pencereyi kapatıp Terminal’e tıklayın.]\x1b[0m');
        } else if (!disposed) {
          terminal.writeln('\r\n\x1b[91mFoxOS terminal oturumu açılamadı. Oturumunuzu yenileyip tekrar deneyin.\x1b[0m');
        }
      });
      socket.addEventListener('error', () => {
        if (!disposed && !connected) {
          terminal.writeln('\r\n\x1b[91mTerminal WebSocket bağlantısı kurulamadı.\x1b[0m');
        }
      });
    } catch {
      terminal.writeln('\r\n\x1b[91mTerminal bağlantısı başlatılamadı.\x1b[0m');
    }

    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(fit);
    });
    resizeObserver.observe(container);
    window.addEventListener('resize', fit);
    window.requestAnimationFrame(fit);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      window.removeEventListener('resize', fit);
      inputSubscription.dispose();
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close(1000, 'Terminal window closed');
      }
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (focusedWindowId === 'terminal') terminalRef.current?.focus();
  }, [focusedWindowId]);

  return (
    <div
      ref={containerRef}
      aria-label="FoxOS Host Terminal"
      style={{
        width: '100%',
        height: '100%',
        padding: '10px 12px',
        background: '#1e1e1e',
        overflow: 'hidden'
      }}
    />
  );
};

export default TerminalApp;
