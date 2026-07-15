# 《修行局》Render 单链接群测部署

本版本使用一个 Render Web Service 同时提供网页、`/ws` WebSocket、房间状态保存和 AI 代理。测试者只需要打开 HTTPS 链接，不填写服务器地址、端口或 API Key。

## 部署

1. 将包含 `render.yaml` 的分支连接到 Render，选择 Blueprint 部署。
2. 确认服务使用 Starter 单实例和 1GB 磁盘，磁盘挂载到 `/var/data`。
3. 填写 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL` 和可选的 `BETA_ACCESS_CODE`。这些值只存在 Render 环境变量中。
4. 部署后检查：

```text
https://<service>.onrender.com/healthz
https://<service>.onrender.com/readyz
https://<service>.onrender.com/api/bootstrap
```

`/healthz` 返回 `ok`；`/readyz` 返回 `ready: true`；`/api/bootstrap` 只包含版本、WebSocket 路径、房间 TTL 和 AI 是否可用，不返回密钥或房间数据。

也可以从开发机对已部署服务执行远程 smoke（不会打印 seatToken、hostToken 或 API Key）：

```bash
CLOUD_BASE_URL=https://<service>.onrender.com BETA_ACCESS_CODE=<optional-code> npm run smoke:cloud
```

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `HOST` / `PORT` | 监听地址；`PORT` 由 Render 注入，不能硬编码公网端口 |
| `DATA_DIR` / `ROOM_SAVE_DIR` | 持久化磁盘和房间目录 |
| `AI_ENABLED` / `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 服务端 AI 配置，绝不发送到浏览器 |
| `BETA_ACCESS_CODE` | 可选内测门槛；邀请 URL 首次读取后会从地址栏移除 |
| `MAX_ROUNDS` | 单局最大回合数，群测默认 12 |
| `ROOM_TTL_MINUTES` / `ROOM_IDLE_MINUTES` | 房间最长存活和无人在线清理时间 |
| `AI_GLOBAL_CONCURRENCY` / `AI_ROOM_CONCURRENCY` | AI 全局和单房间并发上限 |
| `AI_DAILY_BUDGET` | 应用层每日 AI 请求预算；Provider 账户仍需单独设置硬预算和告警 |
| `SERVER_SECRET` | `/admin/metrics` 的 `X-Server-Secret` 请求头 |

## 发布前 smoke

```bash
npm ci
npm start
```

浏览器验收：新设备打开首页，确认自动连接；房主创建后复制 `?room=六位码` 邀请链接；另一台设备打开链接并一键入局；刷新、断网 30 秒、切后台后确认席位恢复。

重部署时 Render 会发送 `SIGTERM`。服务先将 `/readyz` 置为 503，保存房间，发送 `server_notice`，再以 WebSocket code `1012` 关闭；客户端会使用指数退避重新连接并恢复 `roomId + seatId + seatToken`。

不要把服务扩展为多实例。当前房间权威状态在单进程中运行，持久化磁盘只解决实例重启恢复；多实例需要额外的 Redis/Postgres 路由和广播设计。
