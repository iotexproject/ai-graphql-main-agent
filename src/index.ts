import { openai } from "@ai-sdk/openai";
import { streamText, generateId } from "ai";
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ChatRequestBody, Message } from "./Chat";
import { Chat } from "./Chat";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
// Re-export the Chat class for Durable Objects
export { Chat };


type Bindings = Env;

type Props = {
	bearerToken: string;
};

type State = null;

// Worker environment type definition
interface Env {
  OPENAI_API_KEY: string;
  MODEL_NAME?: string;
  DATABASE_URL?: string; // PostgreSQL connection string
  CHAT_CACHE?: KVNamespace; // KV namespace for caching
  Chat: DurableObjectNamespace;
}

// Create Hono app
const app = new Hono<{ Bindings: Env }>();

// Apply CORS middleware
app.use('*', cors({
  origin: '*',
  allowMethods: ['POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Marketplace-ID'],
  maxAge: 86400,
}));

export class MyMCP extends McpAgent<Bindings, State, Props> {
	server = new McpServer({
		name: "Demo",
		version: "1.0.0",
	});

	async init() {
		this.server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
			content: [{ type: "text", text: String(a + b) }],
		}));

		// Tool that returns the user's bearer token
		// This is just for demonstration purposes, don't actually create a tool that does this!
		this.server.tool("getToken", {}, async () => ({
			content: [{ type: "text", text: String(`User's token: ${this.props.bearerToken}`) }],
		}));
	}
}


app.mount("/", (req, env, ctx) => {
	// This could technically be pulled out into a middleware function, but is left here for clarity
	// const authHeader = req.headers.get("authorization");
	// if (!authHeader) {
	// 	return new Response("Unauthorized", { status: 401 });
	// }

	// ctx.props = {
	// 	bearerToken: authHeader,
	// 	// could also add arbitrary headers/parameters here to pass into the MCP client
	// };

	return MyMCP.mount("/sse").fetch(req, env, ctx);
});
// Chat endpoint
app.post('/v1/chat/completions', async (c) => {
  try {
    // Extract token from Authorization header
    const authHeader = c.req.header('Authorization') || '';
    let token = '';
    
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }

    // Extract marketplaceId from header
    const marketplaceId = c.req.header('X-Marketplace-ID');

    // If no token and no marketplaceId, return error
    if (!token && !marketplaceId) {
      return c.json({
        error: {
          message: 'Authentication error: Missing token or marketplaceId',
          type: 'authentication_error',
          code: 'invalid_parameters'
        }
      }, 401);
    }

    // Create a Durable Object ID based on the token or a default ID if only marketplaceId is provided
    const chatId = token 
      ? c.env.Chat.idFromName(token)
      : c.env.Chat.idFromName(`anonymous-${marketplaceId}`);
    
    // Get the Durable Object stub
    const chatDO = c.env.Chat.get(chatId);
    
    // Create a new request with custom headers
    const newRequest = new Request(c.req.url, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body
    });
    
    // Pass token if available
    if (token) {
      newRequest.headers.set('X-Custom-Token', token);
    }
    
    // Pass marketplaceId if available
    if (marketplaceId) {
      newRequest.headers.set('X-Marketplace-ID', marketplaceId);
    }
    
    // Forward the request to the Durable Object
    const response = await chatDO.fetch(newRequest);
    
    // Return the response from the Durable Object
    return new Response(response.body, response);
  } catch (error) {
    // Handle any unexpected errors
    console.error('Error routing chat request:', error);
    return c.json({
      error: {
        message: 'Failed to route chat request',
        type: 'server_error',
        code: 'processing_error',
        details: error instanceof Error ? error.message : String(error)
      }
    }, 500);
  }
});

// Export the default Hono app
export default {
  fetch: app.fetch
};
