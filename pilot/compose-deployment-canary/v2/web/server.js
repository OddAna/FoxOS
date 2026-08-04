const http = require('node:http');

http.createServer((request, response) => {
  if (request.url !== '/') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return response.end('Not found\n');
  }
  const upstream = http.get('http://api:9090/version', { timeout: 2000 }, (upstreamResponse) => {
    let body = '';
    upstreamResponse.setEncoding('utf8');
    upstreamResponse.on('data', (chunk) => { body += chunk; });
    upstreamResponse.on('end', () => {
      if (upstreamResponse.statusCode !== 200) {
        response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        return response.end('Dependency unavailable\n');
      }
      response.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      response.end('FoxOS compose deployment canary v2 + ' + body.trim() + '\n');
    });
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', () => {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Dependency unavailable\n');
  });
}).listen(8080, '0.0.0.0');
