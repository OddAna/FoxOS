const http = require('node:http');

http.createServer((request, response) => {
  response.writeHead(request.url === '/' ? 200 : 404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(request.url === '/' ? 'FoxOS source deployment canary v1\n' : 'Not found\n');
}).listen(8080, '0.0.0.0');
