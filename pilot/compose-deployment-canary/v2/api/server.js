const http = require('node:http');

http.createServer((request, response) => {
  response.writeHead(request.url === '/version' ? 200 : 404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(request.url === '/version' ? 'api-v2\n' : 'Not found\n');
}).listen(9090, '0.0.0.0');
