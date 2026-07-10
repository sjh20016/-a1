# 《修行局》V3.4.0 服务端部署

V3.4.0 使用 Node.js 原生 HTTP 与 WebSocket。服务端是房间、裁决、AI 叙事和存档的唯一权威状态源；浏览器只发送命令并显示经过席位过滤的 `RoomView`。

## 1. 系统准备

推荐 Ubuntu 22.04 或 24.04：

```bash
sudo apt update
sudo apt install -y curl git nginx sqlite3
```

0.5 GB 内存实例建议增加 1 GB swap：

```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

安装 Node.js 20 与 PM2：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

## 2. 部署项目

```bash
cd /opt
sudo git clone https://github.com/sjh20016/-a1 xiuxingju
sudo chown -R "$USER":"$USER" /opt/xiuxingju
cd /opt/xiuxingju
npm install
cp .env.example .env
nano .env
```

至少配置以下字段：

```env
HOST=127.0.0.1
PORT=8787
PUBLIC_ORIGIN=https://your-domain.com
ROOM_SAVE_DIR=./data/rooms

AI_ENABLED=true
AI_BASE_URL=https://api.deepseek.com
AI_API_KEY=replace-with-server-side-key
AI_MODEL=deepseek-chat
AI_TIMEOUT_MS=60000

SERVER_SECRET=replace-with-a-long-random-string
```

`AI_API_KEY` 只放在服务器 `.env` 或进程环境变量中，不能写入 `index.html`、浏览器 localStorage、日志或 Git。若 `AI_ENABLED=true` 但 AI 配置不完整，服务仍可启动；叙事请求会进入 `narration_failed`，房主可在配置修复后重试。

## 3. 启动与健康检查

前台验证：

```bash
npm run server
```

生产环境使用 PM2，并通过 `--update-env` 载入环境变量：

```bash
set -a
. ./.env
set +a
pm2 start server/index.js --name xiuxingju --update-env
pm2 save
pm2 startup
```

健康检查：

```bash
curl http://127.0.0.1:8787/healthz
```

应返回：

```text
ok
```

查看日志：

```bash
pm2 logs xiuxingju
```

## 4. Nginx 反向代理

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8787/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 75s;
    }
}
```

启用配置后检查并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

生产环境应继续配置 HTTPS；浏览器在 HTTPS 页面上会自动使用 `wss://your-domain.com/ws`。

## 5. 存档与升级

房间存档默认位于：

```text
data/rooms/<roomId>.json
```

升级前备份存档和 `.env`：

```bash
cd /opt/xiuxingju
tar -czf /opt/xiuxingju-backup-$(date +%F).tar.gz .env data/rooms
git pull --ff-only
npm install
set -a
. ./.env
set +a
pm2 restart xiuxingju --update-env
```

服务重启后会恢复房间码、席位凭据、当前章节、投票和 `narration_failed` 的待重试裁决。运行中的 Promise、socket 与 API Key 不会写入存档。
