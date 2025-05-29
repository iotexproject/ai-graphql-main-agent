# 多 Worker 部署架构设计

## 当前架构分析

当前项目是一个单体 Cloudflare Worker，包含以下主要功能：
- Chat 聊天服务 (Durable Objects)
- MCP 工具服务 (Model Context Protocol)
- RAG 向量搜索服务 (Pinecone)
- API 密钥管理和用户会话
- 数据库和缓存工具

## 建议的多 Worker 架构

### 1. Chat Worker (`chat-worker`)
**职责**: 处理聊天相关的所有功能
- 路由: `/v1/chat/*`
- 包含: Chat Durable Object, 聊天逻辑
- 依赖: UserSession DO, ApiUsage DO

### 2. MCP Worker (`mcp-worker`)
**职责**: 处理 Model Context Protocol 相关功能
- 路由: `/sse/*`, `/mcp/*`
- 包含: MyMCP Durable Object, Schema 管理, 工具调用
- 依赖: 数据库连接, KV 缓存

### 3. RAG Worker (`rag-worker`)
**职责**: 处理向量搜索和 RAG 功能
- 路由: `/v1/rag/*`
- 包含: Pinecone 集成, 文档嵌入, 向量搜索
- 依赖: OpenAI API

### 4. Gateway Worker (`gateway-worker`)
**职责**: 作为 API 网关，路由请求到对应的 Worker
- 路由: `/*` (所有请求的入口)
- 包含: 认证中间件, 请求路由, 负载均衡
- 依赖: UserSession DO, ApiUsage DO

### 5. Auth Worker (`auth-worker`)
**职责**: 处理认证和用户管理
- 路由: `/auth/*`, `/users/*`
- 包含: API 密钥验证, 用户会话管理
- 依赖: UserSession DO, ApiUsage DO, 数据库

## 架构优势

1. **模块化**: 每个 Worker 专注于特定功能
2. **可扩展性**: 可以独立扩展不同的服务
3. **维护性**: 代码更容易维护和调试
4. **部署灵活性**: 可以独立部署和更新
5. **故障隔离**: 一个服务的问题不会影响其他服务

## 共享资源

### Durable Objects
- `Chat`: 主要在 Chat Worker 中使用
- `UserSession`: 在 Gateway 和 Auth Worker 中共享
- `ApiUsage`: 在 Gateway 和 Auth Worker 中共享
- `MyMCP`: 主要在 MCP Worker 中使用

### KV Namespace
- `CHAT_CACHE`: 在多个 Worker 中共享缓存

### 环境变量
- 所有 Worker 共享相同的环境变量配置

## 实施步骤

1. 创建共享的类型定义和工具函数包
2. 拆分现有代码到对应的 Worker
3. 配置每个 Worker 的 `wrangler.toml`
4. 实现 Gateway Worker 的路由逻辑
5. 测试各个 Worker 的独立功能
6. 配置域名和路由规则

## 注意事项

1. **Durable Objects 绑定**: 需要在多个 Worker 中正确配置 DO 绑定
2. **跨 Worker 通信**: 使用 Service Bindings 或 HTTP 调用
3. **认证共享**: 确保认证逻辑在各个 Worker 中一致
4. **错误处理**: 统一的错误处理和日志记录
5. **监控**: 为每个 Worker 配置独立的监控和告警 