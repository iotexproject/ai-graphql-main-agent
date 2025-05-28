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
import { apiKeyMiddleware } from "./router/middleware";

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
  GATEWAY_PROJECT_ID: string;
  USERSESSION: DurableObjectNamespace<UserSession>;
}

// Application variables type
type Variables = { 
  projectId: string; 
  userId: string | null; 
  token: string | null; 
};

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

// Unified chat routes - handles both project and global chat
app.use(":projectId/v1/chat/completions", apiKeyMiddleware);  
app.post(":projectId/v1/chat/completions", handleUnifiedChat);

// Global chat route (without projectId)
app.post("/v1/chat/completions", handleGlobalChat);

// RAG routes
app.post("/v1/rag/pinecone", ragValidator, handlePineconeRag);
app.get("/rag/doc", handleRagDoc);

// MCP route with authentication handling
app.mount("/", (req, env, ctx) => {
  let authHeader = req.headers.get("authorization");
  const url = new URL(req.url);
  const authParam = url.searchParams.get("authorization");
  
  if (authParam) {
    authHeader = authParam.startsWith("Bearer ") ? authParam : `Bearer ${authParam}`;
  }
  
  console.log(authHeader, "authHeader");
  ctx.props = {};
  
  if (authHeader) {
    ctx.props.bearerToken = authHeader.startsWith("Bearer ") 
      ? authHeader.substring(7) 
      : authHeader;
  }
  
  return MyMCP.mount("/sse").fetch(req, env, ctx);
});

export default {
  fetch: app.fetch.bind(app),
};
