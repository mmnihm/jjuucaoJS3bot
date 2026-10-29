'use strict';

const http = require('node:http');

const PORT = Math.max(1, Number(process.env.PORT) || 3000);
const server = http.createServer((req, res) => {
  const pathname = String(req.url || '/').split('?')[0];
  if (req.method === 'GET' && (pathname === '/' || pathname === '/health' || pathname === '/healthz')) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('ok');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.on('error', (err) => {
  console.error('健康检查服务启动失败：' + err.message);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('健康检查服务已启动，端口：' + PORT);
  // Start the existing Telegram bot only after the platform health server is ready.
  require('./src/index.js');
});
