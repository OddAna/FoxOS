const net = require('node:net');

const HOST_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,252}$/;

function port(value, name) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(name + ' is invalid');
  }
  return parsed;
}

const targetHost = String(process.env.TARGET_HOST || '');
if (!HOST_PATTERN.test(targetHost)) throw new Error('TARGET_HOST is invalid');
const targetPort = port(process.env.TARGET_PORT, 'TARGET_PORT');
const listenPort = port(process.env.LISTEN_PORT, 'LISTEN_PORT');

const server = net.createServer((client) => {
  const upstream = net.connect({ host: targetHost, port: targetPort });
  client.setTimeout(120000, () => client.destroy());
  upstream.setTimeout(120000, () => upstream.destroy());
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});

server.on('error', (error) => {
  console.error('FoxOS dependency bridge failed:', error.message);
  process.exitCode = 1;
});

server.listen(listenPort, '0.0.0.0');

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
