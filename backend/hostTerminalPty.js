const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin';

function mountedHostPath(hostRoot, hostPath) {
  const normalized = path.posix.resolve('/', String(hostPath || ''));
  const mounted = path.resolve(hostRoot, '.' + normalized);
  if (mounted !== hostRoot && !mounted.startsWith(hostRoot + path.sep)) {
    throw new Error('Host terminal path escapes the mounted server root');
  }
  return mounted;
}

function executableHostPath(hostRoot, candidate) {
  try {
    fs.accessSync(mountedHostPath(hostRoot, candidate), fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function rootLoginShell(hostRoot) {
  try {
    const passwd = fs.readFileSync(mountedHostPath(hostRoot, '/etc/passwd'), 'utf8');
    const entry = passwd.split('\n').find((line) => line.startsWith('root:'));
    const candidate = entry && entry.split(':')[6];
    if (
      candidate && /^\/[A-Za-z0-9_./+-]{1,255}$/.test(candidate) &&
      !candidate.split('/').some((part) => part === '..') &&
      !/(?:nologin|false)$/.test(candidate) && executableHostPath(hostRoot, candidate)
    ) {
      return candidate;
    }
  } catch { /* Fall through to known shells. */ }

  return executableHostPath(hostRoot, '/bin/bash') || executableHostPath(hostRoot, '/bin/sh');
}

function terminalEnvironment(shell, source = process.env) {
  const locale = typeof source.LANG === 'string' && /^[A-Za-z0-9_.@-]{1,64}$/.test(source.LANG)
    ? source.LANG
    : 'C.UTF-8';
  return {
    HOME: '/root',
    USER: 'root',
    LOGNAME: 'root',
    SHELL: shell,
    PATH: DEFAULT_PATH,
    LANG: locale,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'FoxOS'
  };
}

function createHostTerminalPtyFactory({
  hostRoot,
  hostExecution,
  loadPty = () => require('node-pty')
} = {}) {
  if (!path.isAbsolute(hostRoot || '') || !['local', 'nsenter'].includes(hostExecution)) {
    throw new TypeError('Invalid host terminal PTY configuration');
  }

  return ({ cols = 80, rows = 24 } = {}) => {
    const shell = rootLoginShell(hostRoot);
    if (!shell) throw new Error('No executable root login shell is available');

    const pty = loadPty();
    const invocation = hostExecution === 'nsenter' ? {
      executable: 'nsenter',
      args: [
        '--target', '1', '--mount', '--uts', '--ipc', '--net', '--pid',
        '--root=/proc/1/root', '--wd=/proc/1/root', '--', shell, '-l'
      ],
      cwd: '/'
    } : {
      executable: shell,
      args: ['-l'],
      cwd: mountedHostPath(hostRoot, '/')
    };

    return pty.spawn(invocation.executable, invocation.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: invocation.cwd,
      env: terminalEnvironment(shell)
    });
  };
}

module.exports = {
  createHostTerminalPtyFactory,
  mountedHostPath,
  rootLoginShell,
  terminalEnvironment
};
