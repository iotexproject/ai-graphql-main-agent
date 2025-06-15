import { Hono, type Context } from "hono";
import { DB } from "../utils/db";
import { createErrorResponse } from "../utils/stream";

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
  USERSESSION: DurableObjectNamespace;
}

type Variables = {
  projectId: string;
  userId: string | null;
  token: string | null;
};

/**
 * Unified chat handler that automatically determines if it's project or global chat
 */
export const handleUnifiedChat = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  try {
    const projectId = c.req.param("projectId");
    console.log(projectId, "projectId");
    return await handleProjectChatLogic(c, projectId);
  } catch (error) {
    console.error("Error in unified chat handler:", error);
    return c.json(
      {
        error: {
          message: "Failed to process chat request",
          type: "server_error",
          code: "processing_error",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500
    );
  }
};

/**
 * Project chat logic
 */
const handleProjectChatLogic = async (c: Context<{ Bindings: Env; Variables: Variables }>, projectId: string) => {
  try {
    const chatId = c.env.Chat.idFromName(projectId);
    const chatDO = c.env.Chat.get(chatId);

    const newRequest = new Request(c.req.url, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
    });
    newRequest.headers.set("X-Project-Id", projectId);
    return chatDO.fetch(newRequest);
  } catch (error) {
    console.error("Error in project chat:", error);
    return c.json(
      {
        error: {
          message: "Failed to route project chat request",
          type: "server_error",
          code: "processing_error",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500
    );
  }
};

/**
 * Global chat logic - Modified to avoid I/O conflicts
 */
const handleGlobalChatLogic = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  try {
    // Use a special project ID for global chat
    const globalChatId = "global-chat-router";
    const chatId = c.env.Chat.idFromName(globalChatId);
    const chatDO = c.env.Chat.get(chatId);

    // Create request with special header to indicate global chat mode
    const newRequest = new Request(c.req.url, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,  // Pass original body stream directly
    });

    // Add special header to indicate this is global chat
    newRequest.headers.set("X-Project-Id", globalChatId);
    newRequest.headers.set("X-Global-Chat", "true");

    const response = await chatDO.fetch(newRequest);
    return new Response(response.body, response);
  } catch (error) {
    console.error("Error in global chat completions:", error);
    return c.json({
      error: {
        message: "Internal server error",
        type: "server_error",
        code: "processing_error",
      },
    }, 500);
  }
};

// Keep original functions for backward compatibility if needed
export const handleProjectChat = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const projectId = c.req.param("projectId");
  return await handleProjectChatLogic(c, projectId);
};

export const handleGlobalChat = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  return await handleGlobalChatLogic(c);
}; 