# Contributing to 数智办公平台 MCP Server

感谢你的贡献！

## 开发流程

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 提交 Pull Request

## 开发环境搭建

```bash
# 克隆仓库
git clone https://github.com/your-org/oa-mcp-server.git
cd oa-mcp-server

# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 构建
npm run build

# 运行
npm start
```

## 代码规范

- 使用 TypeScript
- 遵循 ESLint 规则
- 提交前运行 `npm run build` 确保编译通过

## 提交规范

提交信息格式：`type(scope): description`

类型：
- `feat`: 新功能
- `fix`: 修复 Bug
- `docs`: 文档更新
- `refactor`: 代码重构
- `test`: 测试相关
- `chore`: 构建/工具相关

示例：`feat(api): add car booking tool`
