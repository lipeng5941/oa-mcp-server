# 数智办公平台 MCP Server

> 山钢资本数智办公平台 AI 接入工具，支持所有主流 AI Agent 一键安装。

[![npm version](https://img.shields.io/npm/v/sgs-oa-mcp-server.svg)](https://www.npmjs.com/package/sgs-oa-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0-brightgreen.svg)](https://nodejs.org/)

## ⚠️ 重要：架构说明（部署前必读）

本工具连接山钢资本数智办公平台（OA 系统），**需要以下运行环境**：

| 依赖 | 说明 | 原因 |
|------|------|------|
| **Kimi WebBridge** | 本地运行在 `localhost:10086` 的守护进程 | OA 系统仅支持浏览器 Session 认证，需通过 WebBridge 代理请求 |
| **浏览器登录态** | 已登录 `oatest.sgscf.cn` 的浏览器会话 | WebBridge 利用浏览器 Cookie 访问 OA API |
| **Windows 操作系统** | 当前实现基于 Windows + git-bash | 使用 `curl.exe` 与 WebBridge 通信 |

### 架构图

```
AI Agent (Claude Code / Cursor / ...)
    ↓ MCP Protocol
MCP Server (Node.js)
    ↓ HTTP POST (localhost:10086)
Kimi WebBridge 守护进程
    ↓ CDP Protocol
浏览器（已登录 OA 系统）
    ↓ HTTP + Cookie
数智办公平台 (oatest.sgscf.cn)
```

### 为什么不直接 HTTP 请求？

OA 系统认证基于浏览器 Session Cookie，不支持 API Key / Token 直接调用。Cookie 有效期约 30 分钟，且绑定浏览器指纹，终端直接发送无效。

**当前方案是通过 WebBridge 复用浏览器的登录态**，这是唯一可行的方式。

---

## 🚀 安装

### 前置要求

- Node.js >= 18.0
- Kimi WebBridge 已安装并运行（`http://127.0.0.1:10086`）
- 浏览器已登录 OA 系统（`https://oatest.sgscf.cn`）

### 安装命令

```bash
# 全局安装
npm install -g sgs-oa-mcp-server

# 或 npx 直接运行
npx sgs-oa-mcp-server
```

## 🔧 配置

### 环境变量（可选）

创建 `.env` 文件：

```env
# MCP Server 配置
MCP_API_KEYS=dev-key-001,prod-key-002
PORT=3000
```

> 注：OA 系统地址和认证通过 WebBridge 自动处理，无需手动配置。

---

## 📋 可用工具

| 工具名 | 功能 | 参数 |
|--------|------|------|
| `search_office` | 查询办公场所 | officenm, address, current, size |
| `get_office_detail` | 获取场所详情 | officeid |
| `search_room` | 查询会议室 | roomnm, capacity, building, current, size |
| `get_room_detail` | 获取会议室详情 | roomid |

---

## 📖 使用示例

安装后，在 AI Agent 中直接输入：

```
帮我查一下济南的办公场所
```

或 API 直接调用：

```bash
curl -X POST http://localhost:3000/api/v1/tools/search_office \
  -H "Content-Type: application/json" \
  -H "X-API-Key: dev-key-001" \
  -d '{"officenm": "济南"}'
```

---

## 🐛 常见问题

### Q: 提示 "WebBridge session has no tab"？
确保 WebBridge 守护进程已启动，且浏览器已打开 OA 系统页面。

运行以下命令检查 WebBridge 状态：
```bash
curl http://127.0.0.1:10086/health
```

### Q: 提示 "Failed to fetch"？
浏览器中的 OA 登录态可能已过期。在浏览器中重新访问 `https://oatest.sgscf.cn` 并登录。

### Q: 为什么不能脱离浏览器使用？
OA 系统当前不支持 API Key / Token 认证，必须通过浏览器 Session 访问。如需纯 API 方式，需要 OA 系统开发团队开放 Token 认证接口。

### Q: 安全性如何？
- WebBridge 守护进程仅监听 `localhost`，不暴露到外网
- MCP Server 支持 API Key 认证
- 所有操作记录审计日志（`logs/audit.log`）

---

## 📝 License

MIT © 2026 山钢资本金融科技服务中心

## 🔗 链接

- [操作手册（飞书）](https://ecnqj9hqrzwp.feishu.cn/docx/Qk7mdLVaFoGzSZx8zN9cWZusnhh)
- [npm 包](https://www.npmjs.com/package/sgs-oa-mcp-server)
- [GitHub](https://github.com/lipeng5941/oa-mcp-server)
