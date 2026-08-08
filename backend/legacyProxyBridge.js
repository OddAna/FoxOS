const net = require('node:net');

const HOST_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,252}$/;
const targetHost = String(process.env.TARGET_HOST || '');
if (!HOST_PATTERN.test(targetHost)) throw new Error('TARGET_HOST is invalid');

const servers = [80, 443].map((listenPort) => net.createServer((client) => {
  const upstream = net.connect({ host: targetHost, port: listenPort });
  client.setTimeout(120000, () => client.destroy());
  upstream.setTimeout(120000, () => upstream.destroy());
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
}));

for (const [index, server] of servers.entries()) {
  server.on('error', (error) => {
    console.error('FoxOS legacy ingress bridge failed:', error.message);
    process.exitCode = 1;
  });
  server.listen(index === 0 ? 80 : 443, '0.0.0.0');
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    let remaining = servers.length;
    for (const server of servers) server.close(() => {
      remaining -= 1;
      if (remaining === 0) process.exit(0);
    });
  });
}
