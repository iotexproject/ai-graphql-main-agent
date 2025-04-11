import { openai } from "@ai-sdk/openai";
import { streamText, generateId } from "ai";
import type { ChatRequestBody, Message } from "./Chat";
import { Chat } from "./Chat";

// Re-export the Chat class for Durable Objects
export { Chat };

// Worker entry point
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Only handle POST requests
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      // Extract token from Authorization header
      const authHeader = request.headers.get('Authorization') || '';
      let token = '';
      
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }

      // If no token, return error
      if (!token) {
        return new Response(JSON.stringify({
          error: {
            message: 'Authentication error: Missing token',
            type: 'authentication_error',
            code: 'invalid_token'
          }
        }), { 
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Create a Durable Object ID based on the token
      const chatId = env.Chat.idFromName(token);
      
      // Get the Durable Object stub
      const chatDO = env.Chat.get(chatId);
      
      // Forward the request to the Durable Object
      return await chatDO.fetch(request);
    } catch (error) {
      // Handle any unexpected errors
      console.error('Error routing chat request:', error);
      return new Response(JSON.stringify({
        error: {
          message: 'Failed to route chat request',
          type: 'server_error',
          code: 'processing_error',
          details: error instanceof Error ? error.message : String(error)
        }
      }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
};

// Worker environment type definition
interface Env {
  OPENAI_API_KEY: string;
  MODEL_NAME?: string;
  DATABASE_URL?: string; // PostgreSQL connection string
  CHAT_CACHE?: KVNamespace; // KV namespace for caching
  Chat: DurableObjectNamespace;
}
