# 《修行局》V3.4.4 独立运行包

双击 `start.bat` 启动。首次运行会从 `.env.example` 生成 `.env`；需要 AI 叙事时，在 `.env` 中填写：

```text
AI_ENABLED=true
AI_BASE_URL=https://你的服务地址
AI_API_KEY=你的服务端密钥
AI_MODEL=模型名
```

启动后浏览器会打开 `http://127.0.0.1:8787/`。保持命令窗口开启，按 `Ctrl+C` 停止服务。

目录包含网页、叙事与房间核心、联机客户端、Node 服务端、Render Blueprint、部署文档和运行时 `ws` 模块。API Key 只由 BAT 从本地 `.env` 注入服务端进程，不会写入网页源码。
