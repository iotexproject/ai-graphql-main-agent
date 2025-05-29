# 多 Worker 部署指南

## 项目结构

```
workers/
├── shared/
│   └── types.ts              # 共享类型定义
├── gateway/
│   ├── wrangler.toml         # Gateway Worker 配置
│   └── src/
│       └── index.ts          # Gateway Worker 主逻辑
├── chat/
│   ├── wrangler.toml         # Chat Worker 配置
│   └── src/
│       ├── index.ts          # Chat Worker 主逻辑
│       └── Chat.ts           # Chat Durable Object
├── mcp/
│   ├── wrangler.toml         # MCP Worker 配置
│   └── src/
│       ├── index.ts          # MCP Worker 主逻辑
│       └── MyMCP.ts          # MCP Durable Object
├── rag/
│   ├── wrangler.toml         # RAG Worker 配置
│   └── src/
│       └── index.ts          # RAG Worker 主逻辑
└── auth/
    ├── wrangler.toml         # Auth Worker 配置
    └── src/
        ├── index.ts          # Auth Worker 主逻辑
        ├── UserSession.ts    # UserSession Durable Object
        └── ApiUsage.ts       # ApiUsage Durable Object
```

## 部署步骤

### 1. 准备工作

```bash
# 安装依赖
npm install

# 复制环境变量
cp .dev.vars.example .dev.vars
```

### 2. 配置环境变量

为每个 Worker 创建对应的 `.dev.vars` 文件，或者使用 `wrangler secret` 命令设置生产环境变量：

```bash
# 设置共享的环境变量
wrangler secret put OPENAI_API_KEY --name gateway-worker
wrangler secret put OPENROUTER_API_KEY --name gateway-worker
wrangler secret put DATABASE_URL --name gateway-worker
wrangler secret put GATEWAY_PROJECT_ID --name gateway-worker

# 为其他 Worker 设置相同的变量
wrangler secret put OPENAI_API_KEY --name chat-worker
wrangler secret put OPENAI_API_KEY --name mcp-worker
wrangler secret put OPENAI_API_KEY --name rag-worker
wrangler secret put OPENAI_API_KEY --name auth-worker
```

### 3. 部署顺序

**重要**: 必须按照以下顺序部署，因为存在依赖关系：

#### 3.1 首先部署 Auth Worker (包含 Durable Objects)
```bash
cd workers/auth
wrangler deploy
```

#### 3.2 部署 Chat Worker
```bash
cd workers/chat
wrangler deploy
```

#### 3.3 部署 MCP Worker
```bash
cd workers/mcp
wrangler deploy
```

#### 3.4 部署 RAG Worker
```bash
cd workers/rag
wrangler deploy
```

#### 3.5 最后部署 Gateway Worker
```bash
cd workers/gateway
wrangler deploy
```

### 4. 验证部署

```bash
# 检查 Gateway Worker
curl https://gateway-worker.your-subdomain.workers.dev/health

# 检查各个服务
curl https://gateway-worker.your-subdomain.workers.dev/v1/chat/health
curl https://gateway-worker.your-subdomain.workers.dev/v1/rag/health
curl https://gateway-worker.your-subdomain.workers.dev/sse/health
```

## 本地开发

### 1. 启动所有 Workers

```bash
# 在不同的终端窗口中启动各个 Worker
cd workers/auth && wrangler dev --port 8001
cd workers/chat && wrangler dev --port 8002
cd workers/mcp && wrangler dev --port 8003
cd workers/rag && wrangler dev --port 8004
cd workers/gateway && wrangler dev --port 8000
```

### 2. 配置本地 Service Bindings

在本地开发时，需要修改 Gateway Worker 的配置以指向本地端口：

```toml
# workers/gateway/wrangler.toml (本地开发配置)
[[services]]
binding = "CHAT_WORKER"
service = "http://localhost:8002"

[[services]]
binding = "MCP_WORKER"
service = "http://localhost:8003"

[[services]]
binding = "RAG_WORKER"
service = "http://localhost:8004"

[[services]]
binding = "AUTH_WORKER"
service = "http://localhost:8001"
```

## 监控和日志

### 1. 查看日志
```bash
# 查看特定 Worker 的日志
wrangler tail --name gateway-worker
wrangler tail --name chat-worker
wrangler tail --name mcp-worker
wrangler tail --name rag-worker
wrangler tail --name auth-worker
```

### 2. 监控指标
- 每个 Worker 都配置了 `observability.enabled = true`
- 可以在 Cloudflare Dashboard 中查看各个 Worker 的性能指标
- 建议设置告警规则监控错误率和响应时间

## 故障排除

### 1. Service Binding 问题
- 确保所有依赖的 Worker 都已部署
- 检查 `wrangler.toml` 中的 service 名称是否正确
- 验证 Worker 之间的网络连通性

### 2. Durable Objects 问题
- 确保 DO 类在正确的 Worker 中定义和导出
- 检查 `script_name` 配置是否正确
- 验证迁移配置是否正确应用

### 3. 环境变量问题
- 确保所有必需的环境变量都已设置
- 检查变量名称是否一致
- 验证敏感信息是否使用 `wrangler secret` 设置

## 性能优化

### 1. 缓存策略
- 在 Gateway Worker 中实现智能缓存
- 使用 KV 存储共享缓存数据
- 实现请求去重和批处理

### 2. 负载均衡
- 在 Gateway Worker 中实现负载均衡逻辑
- 根据请求类型和负载情况路由请求
- 实现故障转移机制

### 3. 资源优化
- 监控各个 Worker 的 CPU 和内存使用情况
- 根据实际负载调整 Worker 配置
- 优化 Durable Objects 的使用模式

## 安全考虑

### 1. 认证和授权
- 在 Gateway Worker 中统一处理认证
- 实现细粒度的权限控制
- 使用安全的 API 密钥管理

### 2. 网络安全
- 配置适当的 CORS 策略
- 实现请求限流和防护
- 监控异常访问模式

### 3. 数据保护
- 确保敏感数据的加密传输和存储
- 实现数据访问审计
- 定期更新安全配置 