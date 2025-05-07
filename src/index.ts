import { openai } from "@ai-sdk/openai";
import { streamText, generateId } from "ai";
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ChatRequestBody, Message } from "./Chat";
import { Chat } from "./Chat";
import { McpAgent } from "agents/mcp";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { KVCache } from "./utils/kv";
import { DB } from "./utils/db";
import axios from 'axios';
import { getFullTypeName, isNonNullType, handleHttpRequest, handleSchemaDetails, getSchemaByMarketplaceId, getSchemasByToken, handleListSchemas } from "./utils/tool-handlers";
// Re-export the Chat class for Durable Objects
export { Chat };


type Bindings = Env;

type Props = {
  bearerToken: string;
  marketplaceId?: string;
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

// Remote Schema interface
interface RemoteSchema {
  id: string;
  name: string;
  description?: string;
  endpoint: string;
  headers: Record<string, string>;
  schemaData: {
    rootFields: {
      name: string;
      description?: string;
    }[];
    rawSchema: any;
  };
  createdAt?: string;
}

// Chat响应接口
interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices?: Array<{
    index: number;
    message?: {
      role: string;
      content: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: {
    message: string;
    type: string;
    code: string;
  };
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
  server = new Server({
    name: "Demo",
    version: "1.0.0"
  }, {
    capabilities: {
      tools: {},
    },
  });

  async init() {
    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      console.log(this.props.bearerToken);
      const token = this.props.bearerToken || "";
      const marketplaceId = this.props.marketplaceId || "";
      
      if (!token && !marketplaceId) {
        throw new Error("Missing token or marketplaceId");
      }
      
      // 使用通用函数处理Schema列表
      const result = await handleListSchemas({
        token,
        marketplaceId,
        forDescription: true,
        env: this.env
      });
      
      if (!result.success) {
        throw new Error(result.error);
      }

      return {
        tools: [
          {
            name: "list_schemas",
            description: `${result.remoteSchemasInfo}.再调用任何工具之前，请先调用list_schemas工具获取Schema列表。
            如果在会话中已经知道了Schema列表，请直接调用schema_details工具获取详细信息。
            用户询问此MCP服务的功能，请直接返回list_schemas工具的描述信息。`,
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
          {
            name: "schema_details",
            description: "Get detailed information about GraphQL schema fields, including arguments, input and output types",
            inputSchema: {
              type: "object",
              properties: {
                remoteSchemaId: {
                  type: "string",
                  description: "The remoteSchema ID to fetch schema details for (use this OR marketplaceId)",
                },
                marketplaceId: {
                  type: "string",
                  description: "The marketplace ID to fetch schema details for (use this OR remoteSchemaId)",
                },
                queryFields: {
                  type: "array",
                  items: {
                    type: "string"
                  },
                  description: "List of field names to get details for (can be query or mutation fields)",
                }
              },
              required: ["queryFields"],
            },
          },
          {
            name: "http_request",
            description: "Send HTTP requests to external APIs, including GraphQL endpoints",
            inputSchema: {
              type: "object",
              properties: {
                url: {
                  type: "string",
                  description: "The URL to make the request to",
                },
                method: {
                  type: "string",
                  enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
                  description: "The HTTP method to use",
                },
                headers: {
                  type: "object",
                  additionalProperties: { type: "string" },
                  description: "HTTP headers to include in the request",
                },
                body: {
                  type: "object",
                  description: "The request body (for POST, PUT, etc.)",
                },
                params: {
                  type: "object",
                  additionalProperties: { type: "string" },
                  description: "URL query parameters",
                }
              },
              required: ["url", "method"],
            },
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.log(request.params);
      const args = request.params.arguments || {};
      const token = this.props.bearerToken || "";
      const marketplaceId = this.props.marketplaceId || "";
      
      if (!token && !marketplaceId) {
        return {
          content: [{ type: "text", text: "错误：需要提供token或marketplaceId才能使用工具" }],
        };
      }
      
      switch (request.params.name) {
        case "list_schemas":
          try {
            // 使用通用函数处理Schema列表
            const result = await handleListSchemas({
              token,
              marketplaceId,
              forDescription: false,
              env: this.env
            });
            
            if (!result.success) {
              return {
                content: [{ type: "text", text: result.error || "获取Schema列表失败" }],
              };
            }
            
            return {
              content: [{ type: "text", text: result.schemaInfo }],
            };
          } catch (error) {
            console.error("ListSchema error:", error);
            return {
              content: [{ type: "text", text: `获取Schema信息失败: ${error instanceof Error ? error.message : String(error)}` }],
            };
          }
          
        case "schema_details":
          try {
            // 使用通用工具处理Schema详情查询
            const result = await handleSchemaDetails({
              remoteSchemaId: args.remoteSchemaId as string | undefined,
              marketplaceId: (args.marketplaceId as string) || marketplaceId,
              queryFields: Array.isArray(args.queryFields) ? args.queryFields : [],
              env: this.env
            });
            
            if (!result.success) {
              return {
                content: [{ type: "text", text: `获取Schema详情失败: ${result.error}` }],
              };
            }
            
            return {
              content: [{ type: "text", text: JSON.stringify(result.fieldDetails, null, 2) }],
            };
          } catch (error) {
            console.error("SchemaDetails error:", error);
            return {
              content: [{ type: "text", text: `获取Schema详情失败: ${error instanceof Error ? error.message : String(error)}` }],
            };
          }
          
        case "http_request":
          try {
            // 使用通用工具处理HTTP请求
            const result = await handleHttpRequest({
              url: args.url as string,
              method: args.method as string,
              headers: args.headers as Record<string, string> | undefined,
              body: args.body,
              params: args.params as Record<string, string> | undefined,
              env: this.env
            });
            
            if (result.error) {
              return {
                content: [{ 
                  type: "text", 
                  text: `HTTP请求失败 (${result.status || ''}): ${result.statusText || result.message || '未知错误'}\n\n${result.data ? JSON.stringify(result.data, null, 2) : ''}` 
                }],
              };
            }
            
            return {
              content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
            };
          } catch (error) {
            console.error("HTTP request error:", error);
            
            return {
              content: [{ type: "text", text: `HTTP请求失败: ${error instanceof Error ? error.message : String(error)}` }],
            };
          }
          
        default:
          return {
            content: [{ type: "text", text: "工具不存在" }],
          };
      }
    });
  }
}


app.mount("/", (req, env, ctx) => {
  // 从 headers 获取认证信息
  let authHeader = req.headers.get("authorization");
  let marketplaceId = req.headers.get("x-marketplace-id");
  
  // 从 URL 参数获取认证信息
  const url = new URL(req.url);
  const authParam = url.searchParams.get("authorization");
  const marketplaceParam = url.searchParams.get("x-marketplace-id");
  
  // 优先使用 URL 参数
  if (authParam) {
    authHeader = authParam.startsWith('Bearer ') ? authParam : `Bearer ${authParam}`;
  }
  if (marketplaceParam) {
    marketplaceId = marketplaceParam;
  }

  console.log(authHeader, marketplaceId, 'authHeader');
  
  // 设置props
  ctx.props = {};
  
  if (authHeader) {
    ctx.props.bearerToken = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
  }
  
  if (marketplaceId) {
    ctx.props.marketplaceId = marketplaceId;
  }

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
