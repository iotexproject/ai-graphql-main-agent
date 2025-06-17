import { Hono } from "hono";
import { cors } from "hono/cors";
import { Chat } from "./ai/Chat";
import { KVCache } from "./utils/kv";
import { DB } from "./utils/db";
import type { UserSession } from "./storage/UserSession";
import { MyMCP } from "./ai/mcp";

// Import route handlers
import { handleUnifiedChat, handleGlobalChat } from "./router/chat";
import { ragValidator, handlePineconeRag, handleRagDoc } from "./router/rag";
import { apiKeyMiddleware, rateLimitMiddleware } from "./router/middleware";

// import { logger } from 'hono/logger'

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

app.use("/preview/:projectId/v1/chat/completions", apiKeyMiddleware);  
app.post("/preview/:projectId/v1/chat/completions", handleUnifiedChat);

// Unified chat routes - handles both project and global chat
app.use(":projectId/v1/chat/completions", rateLimitMiddleware);  
app.post(":projectId/v1/chat/completions", handleUnifiedChat);

// Global chat route (without projectId)
app.post("/v1/chat/completions", handleGlobalChat);

// RAG routes
app.post("/v1/rag/pinecone", ragValidator, handlePineconeRag);
app.get("/rag/doc", handleRagDoc);

// MCP route with authentication handling
app.mount("/", (req, env, ctx) => {
  const url = new URL(req.url);
  // const authParam = url.searchParams.get("authorization");
  // console.log(authParam, "authParam");
  const pathSegments = url.pathname.split('/').filter(Boolean);
  let projectId = "";

  if (pathSegments.length >= 2 && pathSegments[1] === 'sse') {
    projectId = pathSegments[0];
    console.log(projectId, "extracted projectId from URL path");
  }

  ctx.props = {};

  if (projectId) {
    ctx.props.projectId = projectId;
  }

  return MyMCP.mount("/").fetch(req, env, ctx);
});

export default {
  fetch: app.fetch.bind(app),
};
