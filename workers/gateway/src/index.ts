import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../../shared/types";

const app = new Hono<{ Bindings: Env }>();

// CORS 中间件
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "x-api-key", "withToolEvent"],
  maxAge: 86400,
}));

// 认证中间件
app.use("*", async (c, next) => {
  // 对于某些公开路由，跳过认证
  const publicRoutes = ["/health", "/docs"];
  if (publicRoutes.some(route => c.req.path.startsWith(route))) {
    return next();
  }

  // 提取认证信息
  const authHeader = c.req.header("Authorization");
  const apiKey = c.req.header("x-api-key");

  if (!authHeader && !apiKey) {
    return c.json({
      error: {
        message: "Authentication required",
        type: "authentication_error",
        code: "missing_auth"
      }
    }, 401);
  }

  // 将认证信息传递给下游服务
  return next();
});

// 健康检查
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Chat 路由 - 转发到 Chat Worker
app.all("/v1/chat/*", async (c) => {
  try {
    const response = await c.env.CHAT_WORKER!.fetch(c.req.raw);
    return new Response(response.body, response);
  } catch (error) {
    console.error("Chat worker error:", error);
    return c.json({
      error: {
        message: "Chat service unavailable",
        type: "service_error",
        code: "chat_worker_error"
      }
    }, 503);
  }
});

// MCP 路由 - 转发到 MCP Worker
app.all("/sse/*", async (c) => {
  try {
    const response = await c.env.MCP_WORKER!.fetch(c.req.raw);
    return new Response(response.body, response);
  } catch (error) {
    console.error("MCP worker error:", error);
    return c.json({
      error: {
        message: "MCP service unavailable",
        type: "service_error",
        code: "mcp_worker_error"
      }
    }, 503);
  }
});

// RAG 路由 - 转发到 RAG Worker
app.all("/v1/rag/*", async (c) => {
  try {
    const response = await c.env.RAG_WORKER!.fetch(c.req.raw);
    return new Response(response.body, response);
  } catch (error) {
    console.error("RAG worker error:", error);
    return c.json({
      error: {
        message: "RAG service unavailable",
        type: "service_error",
        code: "rag_worker_error"
      }
    }, 503);
  }
});

// 认证路由 - 转发到 Auth Worker
app.all("/auth/*", async (c) => {
  try {
    const response = await c.env.AUTH_WORKER!.fetch(c.req.raw);
    return new Response(response.body, response);
  } catch (error) {
    console.error("Auth worker error:", error);
    return c.json({
      error: {
        message: "Auth service unavailable",
        type: "service_error",
        code: "auth_worker_error"
      }
    }, 503);
  }
});

// 默认路由 - 返回 API 文档
app.get("/", (c) => {
  return c.json({
    name: "GraphQL Main Agent Gateway",
    version: "1.0.0",
    services: {
      chat: "/v1/chat/*",
      mcp: "/sse/*",
      rag: "/v1/rag/*",
      auth: "/auth/*"
    },
    health: "/health"
  });
});

// 404 处理
app.notFound((c) => {
  return c.json({
    error: {
      message: "Route not found",
      type: "not_found",
      code: "route_not_found"
    }
  }, 404);
});

export default {
  fetch: app.fetch.bind(app),
}; 