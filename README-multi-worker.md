# GraphQL Main Agent - 多 Worker 架构

这是一个基于 Cloudflare Workers 的多服务架构，将原本的单体 Worker 拆分为多个专门的 Worker 服务。

## 🏗️ 架构概览

```
┌─────────────────┐
│  Gateway Worker │  ← 主入口，负责路由和认证
└─────────┬───────┘
          │
    ┌─────┴─────┐
    │           │
┌───▼───┐   ┌───▼───┐   ┌─────────┐   ┌─────────┐
│ Chat  │   │  MCP  │   │   RAG   │   │  Auth   │
│Worker │   │Worker │   │ Worker  │   │ Worker  │
└───────┘   └───────┘   └─────────┘   └─────────┘
```

## 🎯 Worker 职责分工

### 1. **Gateway Worker** (`gateway-worker`)
- **入口点**: 所有请求的统一入口
- **职责**: 路由分发、认证验证、负载均衡
- **路由**: `/*` (所有请求)

### 2. **Chat Worker** (`chat-worker`)
- **职责**: 处理聊天对话功能
- **路由**: `/v1/chat/*`
- **包含**: Chat Durable Object

### 3. **MCP Worker** (`mcp-worker`)
- **职责**: Model Context Protocol 工具服务
- **路由**: `/sse/*`, `/mcp/*`
- **包含**: MyMCP Durable Object, Schema 管理

### 4. **RAG Worker** (`rag-worker`)
- **职责**: 向量搜索和检索增强生成
- **路由**: `/v1/rag/*`
- **包含**: Pinecone 集成, 文档嵌入

### 5. **Auth Worker** (`auth-worker`)
- **职责**: 用户认证和会话管理
- **路由**: `/auth/*`
- **包含**: UserSession DO, ApiUsage DO

## 🚀 快速开始

### 1. 迁移现有代码

```bash
# 运行迁移脚本
./migrate-to-multi-worker.sh
```

### 2. 安装依赖

```bash
npm install
```

### 3. 本地开发

```bash
# 启动所有 Workers (需要多个终端)
npm run dev

# 或者分别启动
npm run dev:auth     # 端口 8001
npm run dev:chat     # 端口 8002  
npm run dev:mcp      # 端口 8003
npm run dev:rag      # 端口 8004
npm run dev:gateway  # 端口 8000 (主入口)
```

### 4. 部署到生产环境

```bash
# 按顺序部署所有 Workers
npm run deploy

# 或者分别部署
npm run deploy:auth
npm run deploy:chat
npm run deploy:mcp
npm run deploy:rag
npm run deploy:gateway
```

## 📁 项目结构

```
workers/
├── shared/
│   ├── types.ts              # 共享类型定义
│   ├── utils/                # 共享工具函数
│   └── storage/              # Durable Objects
├── gateway/
│   ├── wrangler.toml
│   └── src/index.ts          # 路由和认证
├── chat/
│   ├── wrangler.toml
│   └── src/
│       ├── index.ts
│       └── Chat.ts           # Chat DO
├── mcp/
│   ├── wrangler.toml
│   └── src/
│       ├── index.ts
│       └── MyMCP.ts          # MCP DO
├── rag/
│   ├── wrangler.toml
│   └── src/index.ts          # RAG 功能
└── auth/
    ├── wrangler.toml
    └── src/
        ├── index.ts
        ├── UserSession.ts    # 用户会话 DO
        └── ApiUsage.ts       # API 使用统计 DO
```

## 🔧 配置说明

### 环境变量

每个 Worker 都需要配置相应的环境变量：

```bash
# 共享变量
OPENAI_API_KEY=your_openai_key
OPENROUTER_API_KEY=your_openrouter_key
DATABASE_URL=your_database_url
GATEWAY_PROJECT_ID=your_project_id

# 特定变量
POLAR_ACCESS_TOKEN=your_polar_token  # 仅部分 Worker 需要
```

### Service Bindings

Gateway Worker 通过 Service Bindings 与其他 Worker 通信：

```toml
[[services]]
binding = "CHAT_WORKER"
service = "chat-worker"

[[services]]
binding = "MCP_WORKER"
service = "mcp-worker"
# ... 其他服务
```

## 🔍 监控和调试

### 查看日志

```bash
# 查看特定 Worker 的日志
npm run logs:gateway
npm run logs:chat
npm run logs:mcp
npm run logs:rag
npm run logs:auth
```

### 健康检查

```bash
# 检查 Gateway
curl https://your-gateway.workers.dev/health

# 检查各个服务
curl https://your-gateway.workers.dev/v1/chat/health
curl https://your-gateway.workers.dev/v1/rag/health
```

## 📈 优势

1. **模块化**: 每个 Worker 专注于特定功能
2. **可扩展性**: 可以独立扩展不同的服务
3. **维护性**: 代码更容易维护和调试
4. **部署灵活性**: 可以独立部署和更新
5. **故障隔离**: 一个服务的问题不会影响其他服务
6. **性能优化**: 可以针对不同服务进行优化

## 🛠️ 开发指南

### 添加新功能

1. 确定功能属于哪个 Worker
2. 在对应的 Worker 中添加路由和逻辑
3. 如果需要跨 Worker 通信，使用 Service Bindings
4. 更新 Gateway Worker 的路由配置

### 调试技巧

1. 使用 `wrangler tail` 查看实时日志
2. 在 Gateway Worker 中添加请求追踪
3. 使用 Cloudflare Dashboard 监控性能指标

## 📚 相关文档

- [multi-worker-architecture.md](./multi-worker-architecture.md) - 详细架构设计
- [deployment-guide.md](./deployment-guide.md) - 完整部署指南
- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [Service Bindings 文档](https://developers.cloudflare.com/workers/runtime-apis/service-bindings/)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request 来改进这个多 Worker 架构！

## �� 许可证

MIT License 