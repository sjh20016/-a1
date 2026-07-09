/**
 * server/index.js — 联机后端入口（HTTP + WebSocket）
 * ============================================================================
 * 静态文件服务：
 *   GET /              → index.html
 *   GET /story-core.js → story-core.js
 *   GET /room-core.js  → room-core.js
 *   GET /public/*      → public/*
 *   GET /healthz       → ok
 *
 * WebSocket 入口：/ws
 *
 * 启动：npm run server
 * ============================================================================
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const config = require('./config');
const logger = require('./utils/logger');
const runtime = require('./room-runtime');
const aiProvider = require('./ai-provider');
const Story = require('../story-core.js');
const fileStore = require('./persistence/file-store');

const ROOT = path.resolve(__dirname, '..');

/* ============================================================
 * 静态文件服务
 * ============================================================ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function safeStatic(reqPath) {
  // 防路径穿越
  const clean = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
  return path.join(ROOT, clean);
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  // /healthz
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  const fp = safeStatic(urlPath);
  // 确保文件在 ROOT 内
  if (fp.indexOf(ROOT) !== 0) {
    res.writeHead(403); res.end('forbidden'); return;
  }

  fs.readFile(fp, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ============================================================
 * 启动
 * ============================================================ */
function start(options) {
  options = options || {};

  // 初始化存档目录
  const saveDir = options.saveDir || config.ROOM_SAVE_DIR;
  fileStore.init(saveDir);

  // 注册 AI Provider（允许测试注入 Mock）
  aiProvider.register(Story, options.aiProviderOverride || null);

  // 恢复存档房间
  if (options.restore !== false) {
    runtime.restoreOnStartup();
  }

  const server = http.createServer(serveStatic);

  const wss = new WebSocketServer({ server: server, path: '/ws' });

  wss.on('connection', function connection(ws, req) {
    logger.info('ws', '新连接 ' + (req.socket.remoteAddress || ''));

    ws.on('message', function incoming(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch (e) {
        ws.send(JSON.stringify({ requestId: '', type: 'error', error: { code: 'INVALID_JSON', message: '非法 JSON' } }));
        return;
      }
      runtime.handleMessage(ws, msg);
    });

    ws.on('close', function () {
      runtime.handleDisconnect(ws);
    });

    ws.on('error', function (e) {
      logger.warn('ws', 'socket 错误', { error: e.message });
    });
  });

  const port = options.port || config.PORT;
  const host = options.host || config.HOST;

  return new Promise(function (resolve, reject) {
    server.on('error', function (e) { reject(e); });
    server.listen(port, host, function () {
      logger.info('server', '《修行局》联机后端已启动', {
        host: host,
        port: port,
        ws: '/ws',
        origin: config.PUBLIC_ORIGIN || ('http://' + host + ':' + port),
      });
      resolve(server);
    });
  });
}

// 直接运行
if (require.main === module) {
  start().catch(function (e) { logger.error('server', '启动失败', { error: e.message }); process.exit(1); });
}

module.exports = { start, config };
