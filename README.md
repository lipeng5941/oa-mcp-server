# 数智办公平台 MCP Server

> 山钢资本数智办公平台 AI 接入工具，支持所有主流 AI Agent 一键安装。

[![npm version](https://img.shields.io/npm/v/@sgs/oa-mcp-server.svg)](https://www.npmjs.com/package/@sgs/oa-mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/@sgs/oa-mcp-server.svg)](https://www.npmjs.com/package/@sgs/oa-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0-brightgreen.svg)](https://nodejs.org/)

## ✨ 特性

- 🔌 **一键安装**：一条命令，10 秒接入
- 🤖 **全 Agent 支持**：Claude Code、Cursor、Cline、Windsurf、Continue、豆包、千问、DeepSeek、Kimi、元宝、智谱清言、Codex、WorkBuddy、Claw 等
- 🔒 **安全可靠**：API Key 认证，操作可审计
- 📦 **零依赖**：npm 自动安装，无需手动配置
- 📖 **完全开源**：基于 MCP 标准协议，可自由扩展

## 🚀 快速开始

### 前置要求

- Node.js >= 18.0
- 数智办公平台 API Key（联系管理员获取）

### 安装

```bash
# 全局安装（推荐）
npm install -g @sgs/oa-mcp-server

# 或项目级安装
npm install @sgs/oa-mcp-server --save-dev
```

### 使用

#### Claude Code / Cursor / Cline / Windsurf

在项目根目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "sgs-oa": {
      "command": "npx",
      "args": ["@sgs/oa-mcp-server"]
    }
  }
}
```

重启 AI Agent 即可使用。

#### 其他 AI Agent

支持 MCP 协议的同上配置。

支持自定义 API 的（豆包/千问/DeepSeek/Kimi 等），在 Agent 中添加 HTTP 工具：

| 配置项 | 值 |
|--------|-----|
| 请求方式 | POST |
| 请求地址 | `http://<服务器地址>:3000/api/v1/tools/search_office` |
| Headers | `Content-Type: application/json`<br>`X-API-Key: 你的API Key` |

## 📋 可用工具

| 工具名 | 功能 | 参数 |
|--------|------|------|
| `search_office` | 查询办公场所 | officenm, address, current, size |
| `get_office_detail` | 获取场所详情 | officeid |
| `search_room` | 查询会议室 | roomnm, capacity, building, current, size |
| `get_room_detail` | 获取会议室详情 | roomid |

## 📖 使用示例

```bash
# 自然语言查询
> 帮我查一下济南的办公场所
> 查询容纳20人以上的会议室

# API 直接调用
curl -X POST http://localhost:3000/api/v1/tools/search_office \
  -H "Content-Type: application/json" \
  -H "X-API-Key: 你的API Key" \
  -d '{"officenm": "济南"}'
```

## 🔧 配置

### 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `OA_BASE_URL` | OA 系统地址 | `https://oatest.sgscf.cn/oamgr` |
| `OA_COOKIE` | Session Cookie | (空) |
| `PORT` | HTTP 服务端口 | `3000` |

### 启动参数

```bash
# 本地 stdio 模式（默认）
npx @sgs/oa-mcp-server

# HTTP 远程模式
npx @sgs/oa-mcp-server http

# 自定义端口
PORT=3001 npx @sgs/oa-mcp-server http
```

## 🐛 常见问题

### Q: 安装后 Agent 没有显示工具？
检查 `.mcp.json` 是否在项目根目录，然后重启 Agent。

### Q: 提示 Unauthorized？
检查 API Key 是否正确填写。

### Q: 提示 Failed to fetch？
检查网络连接，确保能访问 OA 系统。

## 🔐 API Key 申请

请联系数智办公平台管理员申请 API Key。

## 📝 License

[MIT](./LICENSE)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

---

**数智办公平台** | 山钢资本金融科技服务中心
