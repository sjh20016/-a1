# 《修行局》真实联机后端 V0.1 — 云服务器部署文档

单进程 Node.js（HTTP + WebSocket），文件存档，无 Docker / 无数据库。适用于 2 核 2GB 的入门云主机（如本例 `43.139.23.237`）。

---

## 1. 安装 Node.js 20 与基础工具

```bash
sudo apt update
sudo apt install -y curl git nginx

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

sudo npm install -g pm2

node -v   # 应输出 v20.x
```

## 2. 创建 swap（2GB 内存机器建议加 1G swap）

```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 3. 拉取项目并安装依赖

```bash
git clone <你的仓库地址> xiuxingju
cd xiuxingju
npm install   # 安装 jsdom + ws
```

> 仓库内已含 `data/rooms/.gitkeep`，存档目录无需手动建。

## 4. 配置环境变量

在项目根目录创建 `.env`（pm2 不自动读 .env，下面用 ecosystem 注入），或直接用 pm2 ecosystem 文件 `ecosystem.config.js`：

```js
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'xiuxingju',
    script: 'server/index.js',
    env: {
      PORT: 8787,
      HOST: '0.0.0.0',
      AI_ENABLED: 'true',
      AI_BASE_URL: 'https://api.openai.com/v1',
      AI_API_KEY: 'sk-你的密钥',
      AI_MODEL: 'gpt-4o-mini',
      AI_TIMEOUT_MS: '60000',
      AI_TEMPERATURE: '0.8',
      SERVER_SECRET: '请改成一段随机长字符串',
    },
  }],
};
```

> **安全红线**：`AI_API_KEY` 只能存在服务端环境变量里，不能写入 RoomState、不能发给浏览器、不能写入存档、不能写入错误日志。

## 5. 启动（pm2 守护）

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # 按提示执行返回的那条命令，实现开机自启

pm2 logs xiuxingju          # 查看日志
pm2 restart xiuxingju       # 重启（房间会从存档自动恢复）
```

健康检查：

```bash
curl http://localhost:8787/healthz   # 返回 ok
```

## 6. Nginx 反向代理（含 WebSocket /ws）

```nginx
server {
    listen 80;
    server_name your-domain.com;   # 或直接写 43.139.23.237

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8787/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;
    }
}
```

启用：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

如需 HTTPS，使用 certbot 申请证书后，Nginx 会自动把 80 跳到 443，WebSocket 走 `wss://`。

## 7. 访问

- 开发期（无域名）：`http://43.139.23.237:8787/`，WebSocket 走 `ws://43.139.23.237:8787/ws`
- 部署 Nginx 后：`https://your-domain.com/`，WebSocket 走 `wss://your-domain.com/ws`（前端 `online-client.js` 会自动按当前页面协议推导）

页面打开后点击 **联机模式（V0.1）** → 填昵称 → 连接 → 创建房间 / 输入房间码加入。

## 8. 存档与重启恢复

- 存档路径：`data/rooms/<roomId>.json`
- 每次状态变化（创建/加入/准备/绑定/投票/结算/回合发布/失败/重试）都会原子写入（tmp + rename）
- 服务器重启后 `loadAllRooms()` 会自动加载全部房间并重建 `roomCode → roomId` 映射
- 状态修复规则：
  - `resolving` + 有 `pendingResolution` → 恢复为 `narration_failed`（房主可重试）
  - `resolving` 无 `pendingResolution` → 恢复为 `collecting`
  - `locked` → 恢复为 `collecting`
  - `generating` → 恢复为 `lobby`
- 玩家刷新页面后用 `localStorage` 里的 `roomCode` + `seatToken` 走 `reconnect` 命令恢复席位

## 9. 备份

```bash
# 备份全部房间存档
tar -czf rooms-$(date +%F).tar.gz data/rooms/
```

## 10. 常见问题

- **连不上 WebSocket**：检查云主机安全组是否放行 8787（或 Nginx 的 80/443）；检查 Nginx 的 `/ws` location 是否带 `Upgrade`/`Connection` 头。
- **AI 叙事一直失败**：`pm2 logs` 看 `narration_failed` 错误；确认 `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` 正确；可临时把 `AI_ENABLED=false` 走离线兜底（仅调试，正式局不建议）。
- **内存吃紧**：确认 swap 已启用（`free -h`）；2GB 机器单进程 Node 足够，但并发房间数不宜过高。
- **房间码失联**：直接用 `roomId`（形如 `room_xxxx`）走 `reconnect` 也可恢复，二者任一即可。
