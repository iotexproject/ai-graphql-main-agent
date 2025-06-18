import { Hono } from "hono";
import { cors } from "hono/cors";
import { Chat } from "./ai/chat";
import { KVCache } from "./utils/kv";
import { DB } from "./utils/db";
import type { UserSession } from "./storage/UserSession";
import { MyMCP } from "./ai/mcp";

// Import route handlers
import { handleUnifiedChat, handleGlobalChat } from "./router/chat";
import { ragValidator, handlePineconeRag, handleRagDoc } from "./router/rag";
import { apiKeyMiddleware, rateLimitMiddleware } from "./router/middleware";

// Re-export for Durable Objects
export { Chat };
export { ApiUsage } from "./storage/ApiUsage";
export { UserSession } from "./storage/UserSession";
export { MyMCP } from "./ai/mcp";

// Worker environment interface
interface Env {
  OPENROUTER_API_KEY: string;
  OPENAI_API_KEY: string;
  MODEL_NAME?: string;
  DATABASE_URL?: string;
  CHAT_CACHE?: KVNamespace;
  Chat: DurableObjectNamespace;
  POLAR_ACCESS_TOKEN?: string;
  USERSESSION: DurableObjectNamespace<UserSession>;
}

// Application variables type
type Variables = {
  projectId: string;
  userId: string | null;
  token: string | null;
}
// Create Hono app with proper typing
const app = new Hono<{
  Bindings: Env;
  Variables: Variables;
}>();

// Apply CORS middleware
app.use("*", cors({
  origin: "*",
  allowMethods: ["POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "withToolEvent"],
  maxAge: 86400,
}));

// Global initialization middleware
app.use("*", async (c, next) => {
  DB.initialize(c.env.DATABASE_URL);
  KVCache.initialize(c.env.CHAT_CACHE);
  return next();
});
// app.use(logger());
// Global chat route (without projectId) - must be before parameterized routes
app.post("/v1/chat/completions", handleGlobalChat);

// Preview routes with API key middleware
app.use("/preview/:projectId/v1/chat/completions", apiKeyMiddleware);
app.post("/preview/:projectId/v1/chat/completions", handleUnifiedChat);

// Unified chat routes - handles both project and global chat  
app.use("/:projectId/v1/chat/completions", rateLimitMiddleware);
app.post("/:projectId/v1/chat/completions", handleUnifiedChat);

// RAG routes
app.post("/v1/rag/pinecone", ragValidator, handlePineconeRag);
app.get("/rag/doc", handleRagDoc);

// Catch-all for any unmatched chat completions to prevent MCP interference
app.all("*/chat/completions", (c) => {
  console.log(`Unmatched chat completion request: ${c.req.url}`);
  return c.json({
    error: {
      message: "Chat completion endpoint not found",
      type: "not_found",
      code: "endpoint_not_found"
    }
  }, 404);
});

// MCP mount with improved routing logic
app.mount("/", (req, env, ctx) => {
  const url = new URL(req.url);
  const pathSegments = url.pathname.split('/').filter(Boolean);
  let projectId = "";

  console.log(`Mount handler called for path: ${url.pathname}`);
  
  // Handle SSE requests specifically
  if (pathSegments.length >= 2 && pathSegments[1] === 'sse') {
    projectId = pathSegments[0];
    console.log(`SSE request detected for project: ${projectId}`);
    
    ctx.props = {};
    if (projectId) {
      ctx.props.projectId = projectId;
    }
    
    return MyMCP.mount("/").fetch(req, env, ctx);
  }
  
  // Explicitly avoid handling chat completion endpoints
  if (url.pathname.includes('/chat/completions')) {
    console.log(`Chat completion request detected, should not reach mount handler: ${url.pathname}`);
    return new Response("Route not found", { status: 404 });
  }
  
  // Avoid handling other specific endpoints
  if (url.pathname.includes('/rag/') || 
      url.pathname.includes('/preview/') ||
      url.pathname.startsWith('/v1/')) {
    console.log(`Specific endpoint detected, not handling in mount: ${url.pathname}`);
    return new Response("Route not found", { status: 404 });
  }
  
  // Handle MCP requests for other endpoints
  if (pathSegments.length >= 1) {
    projectId = pathSegments[0];
    console.log(`MCP request detected for project: ${projectId}`);
    
    ctx.props = {};
    if (projectId) {
      ctx.props.projectId = projectId;
    }
    
    return MyMCP.mount("/").fetch(req, env, ctx);
  }
  
  // For unmatched requests, return 404
  console.log(`Unmatched request in mount handler: ${url.pathname}`);
  return new Response("Not Found", { status: 404 });
});

export default {
  fetch: app.fetch.bind(app),
};
