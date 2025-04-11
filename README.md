# AI Chat API 服务

基于Cloudflare Workers的OpenAI兼容聊天API服务，具有会话持久化和数据库集成功能。

## 功能特点

- 兼容OpenAI Chat API格式
- 使用Durable Objects实现会话持久化
- PostgreSQL数据库集成
- 支持流式响应
- 支持工具调用（如HttpTool）
- 自动加载GraphQL marketplace查询并增强提示词
- KV缓存优化数据库查询性能

## 环境要求

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- PostgreSQL数据库（可选）

## 安装

1. 克隆仓库

```bash
git clone https://github.com/yourusername/ai-chat-api.git
cd ai-chat-api
```

2. 安装依赖

```bash
npm install
```

## 配置

### 环境变量

创建一个`.dev.vars`文件用于本地开发（示例）：

```
OPENAI_API_KEY=sk-your-openai-api-key
MODEL_NAME=gpt-4o-2024-11-20
DATABASE_URL=postgresql://username:password@host:port/database
```

### 设置秘密环境变量

对于生产环境，使用Wrangler CLI设置秘密：

```bash
# 设置OpenAI API密钥
wrangler secret put OPENAI_API_KEY

# 设置数据库连接字符串
wrangler secret put DATABASE_URL
```

## 本地开发

```bash
npm run dev
```

访问 `http://localhost:8787` 测试API。

## 部署

1. 登录Cloudflare（如果尚未登录）

```bash
wrangler login
```

2. 部署Worker

```bash
npm run deploy
```

## API使用

### 请求格式

发送POST请求到API端点，格式与OpenAI Chat API兼容：

```json
{
  "messages": [
    {"role": "system", "content": "你是一个有用的AI助手。"},
    {"role": "user", "content": "你好，请告诉我今天是星期几？"}
  ],
  "stream": true
}
```

### 身份验证

使用Bearer令牌进行身份验证：

```
Authorization: Bearer your-token-here
```

## 数据库集成

本服务使用PostgreSQL存储和检索数据。数据库连接配置通过`DATABASE_URL`环境变量提供。

### 数据库连接方式

本服务使用`pg`库直接连接PostgreSQL数据库，采用连接池方式优化性能:

```typescript
// 创建连接池
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5, // 最大连接数
  idleTimeoutMillis: 30000, // 连接最大空闲时间
  connectionTimeoutMillis: 5000 // 连接超时
});
```

### Marketplace数据

服务会自动从数据库的`marketplaces`表中加载GraphQL查询数据，并将其添加到AI的提示词中。这样AI能够了解可用的GraphQL查询字段，并在对话中使用它们。

数据结构如下：
```typescript
interface Marketplace {
  id: string;
  name: string;
  description?: string;
  endpoint: string;
  headers: Record<string, string>;
  rootFields: {
    name: string;
    description?: string;
  }[];
  createdAt?: string;
}
```

### KV缓存

为了提高性能，marketplace数据会被缓存到Cloudflare KV中，默认缓存时间为1小时。要设置KV：

1. 创建KV命名空间：
```bash
wrangler kv namespace create CHAT_CACHE
wrangler kv namespace create CHAT_CACHE --preview
```

2. 将创建的ID更新到`wrangler.toml`中：
```toml
[[kv_namespaces]]
binding = "CHAT_CACHE"
id = "your-kv-id-here"
preview_id = "your-preview-kv-id-here"
```

### 数据库设置

要在生产环境中使用PostgreSQL：

1. 创建PostgreSQL数据库并获取连接字符串
2. 使用Wrangler设置DATABASE_URL秘密：

```bash
wrangler secret put DATABASE_URL
```

## 自定义和扩展

### 添加新工具

1. 在`tools`目录中创建新的工具模块
2. 在`Chat.ts`中导入并注册工具

### 修改模型

在`.dev.vars`或通过Wrangler secret设置`MODEL_NAME`变量来切换不同的模型。

## 许可

[MIT许可证](LICENSE)
