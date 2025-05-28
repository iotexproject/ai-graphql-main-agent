import { openai } from "@ai-sdk/openai";
import { embed } from "ai";
import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { Chat } from "./Chat";
import { McpAgent } from "agents/mcp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import "zod-openapi/extend";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { KVCache } from "./utils/kv";
import { DB } from "./utils/db";
import { handleSchemaDetails, handleListSchemas } from "./utils/tool-handlers";
import { getApiKeyManager } from "./utils/apikey";
import type { UserSession } from "./storage/UserSession";
import { handleHTTPRequest } from "./HttpTool";
import { PineconeVector } from "@mastra/pinecone";
import { zValidator } from "@hono/zod-validator";
import { createDocument } from "zod-openapi";
import { cloudflareRateLimiter, WorkersKVStore } from "@hono-rate-limiter/cloudflare";
import { rateLimiter } from "hono-rate-limiter";
import { updateRateLimit, setRateLimitHeaders, shouldSkipCounting, RateLimitOptions, checkRateLimit } from "./middleware/ratelimit";
import { createKVStore } from "./middleware/ratelimit";
// Re-export the Chat class for Durable Objects
export { Chat };
export { ApiUsage } from "./storage/ApiUsage";
export { UserSession } from "./storage/UserSession";

type Bindings = Env;

type Props = {
  bearerToken: string;
};

type State = null;

// Worker environment type definition
interface Env {
  OPENROUTER_API_KEY: string;
  OPENAI_API_KEY: string;
  MODEL_NAME?: string;
  DATABASE_URL?: string; // PostgreSQL connection string
  CHAT_CACHE?: KVNamespace; // KV namespace for caching
  Chat: DurableObjectNamespace;
  POLAR_ACCESS_TOKEN?: string;
  GATEWAY_PROJECT_ID: string;
  USERSESSION: DurableObjectNamespace<UserSession>;
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

const apiKeyMiddleware = async (c: Context, next: Next) => {
  const kvStore = createKVStore(c.env.CHAT_CACHE);

  const options: RateLimitOptions = {
    windowMs: 60 * 1000, // 1 分钟
    max: 1, // 每分钟最多 100 次请求
    store: kvStore,
    headers: true,
  };

  // 检查速率限制
  const rateLimitResult = await checkRateLimit(c, options);

  // 设置响应头部
  setRateLimitHeaders(c, rateLimitResult, options);

  // 如果超过限制，则根据apikey进行验证
  if (!rateLimitResult.success) {

    // Extract token from Authorization header
    const authHeader = c.req.header("Authorization") || "";
    let token = "";
    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    }
    if (!token) {
      return c.json(
        {
          error: {
            message: "Authentication error: Missing API Key",
            type: "authentication_error",
            code: "invalid_parameters",
          },
        },
        401
      );
    }
    // const projectId = c.req.param("projectId")!
    // if (!projectId) {
    //   return c.json(
    //     {
    //       error: {
    //         message: "Missing Project ID",
    //         type: "authentication_error",
    //         code: "invalid_parameters",
    //       },
    //     },
    //     400
    //   );
    // }
    // const projectPrice = await KVCache.wrap(
    //   `project_price_${projectId}`,
    //   async () => {
    //     const projectPrice = await DB.query(
    //       `SELECT pricing->>'price' as price FROM projects WHERE id = $1`,
    //       [token]
    //     );
    //     return projectPrice?.rows[0]?.price;
    //   },
    //   {
    //     ttl: 60,
    //   }
    // );


    const apikey = token
    const userSessionId = c.env.USERSESSION.idFromName(apikey);
    const userSessionDO = c.env.USERSESSION.get(userSessionId);
    const { orgId } = await userSessionDO.init({ apiKey: apikey });
    if (!orgId) {
      return c.json(
        {
          error: {
            message: "Authentication error: Unauthorized API Key",
            type: "authentication_error",
            code: "invalid_parameters",
          },
        },
        401
      );
    }
    // const cost = projectPrice || 1;
    const cost = 1;
    const apiKeyManager = getApiKeyManager(c.env as any);
    const GATEWAY_PROJECT_ID = c.env.GATEWAY_PROJECT_ID;
    const result = await apiKeyManager.verifyKey({
      resourceId: orgId,
      cost,
      projectId: GATEWAY_PROJECT_ID,
    });
    if (!result.success) {
      return c.json(
        {
          error: {
            message: result.message,
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
          },
        },
        429
      );
    }
  }
  await next();
  if (rateLimitResult.success) {
    // 请求完成后更新计数（如果需要）
    const skip = shouldSkipCounting(c, options);
    await updateRateLimit(c, options, skip);
  }
};

// Create Hono app
const app = new Hono<{
  Bindings: Env;
  Variables: { projectId: string; userId: string | null; token: string | null };
}>();

// Apply CORS middleware
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "withToolEvent"],
    maxAge: 86400,
  })
);
app.use("*", async (c, next) => {
  DB.initialize(c.env.DATABASE_URL);
  KVCache.initialize(c.env.CHAT_CACHE);
  return next();
});

export class MyMCP extends McpAgent<Bindings, State, Props> {
  // @ts-ignore
  server!: Server;

  async init() {
    this.server = new Server(
      {
        name: "Demo",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      const token = this.props.bearerToken || "";

      if (!token) {
        throw new Error("Missing authorization token");
      }

      // 使用通用函数处理Schema列表
      const result = await handleListSchemas({
        token,
        marketplaceId: "",
        forDescription: true,
        env: this.env,
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
            description:
              "Get detailed information about GraphQL schema fields, including arguments, input and output types",
            inputSchema: {
              type: "object",
              properties: {
                remoteSchemaId: {
                  type: "string",
                  description:
                    "The remoteSchema ID to fetch schema details for",
                },
                queryFields: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  description:
                    "List of field names to get details for (can be query or mutation fields)",
                },
              },
              required: ["queryFields"],
            },
          },
          {
            name: "http_request",
            description:
              "Send HTTP requests to external APIs, including GraphQL endpoints",
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
                },
              },
              required: ["url", "method"],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.log(request.params);
      const args = request.params.arguments || {};
      const token = this.props.bearerToken || "";

      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: "错误：需要提供authorization token才能使用工具",
            },
          ],
        };
      }

      switch (request.params.name) {
        case "list_schemas":
          try {
            // 使用通用函数处理Schema列表
            const result = await handleListSchemas({
              token,
              marketplaceId: "",
              forDescription: false,
              env: this.env,
            });

            if (!result.success) {
              return {
                content: [
                  { type: "text", text: result.error || "获取Schema列表失败" },
                ],
              };
            }

            return {
              content: [{ type: "text", text: result.schemaInfo }],
            };
          } catch (error) {
            console.error("ListSchema error:", error);
            return {
              content: [
                {
                  type: "text",
                  text: `获取Schema信息失败: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }

        case "schema_details":
          try {
            // 使用通用工具处理Schema详情查询
            const result = await handleSchemaDetails({
              remoteSchemaId: args.remoteSchemaId as string | undefined,
              marketplaceId: "",
              queryFields: Array.isArray(args.queryFields)
                ? args.queryFields
                : [],
              env: this.env,
            });

            if (!result.success) {
              return {
                content: [
                  { type: "text", text: `获取Schema详情失败: ${result.error}` },
                ],
              };
            }

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result.fieldDetails, null, 2),
                },
              ],
            };
          } catch (error) {
            console.error("SchemaDetails error:", error);
            return {
              content: [
                {
                  type: "text",
                  text: `获取Schema详情失败: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }

        case "http_request":
          try {
            // 使用通用工具处理HTTP请求
            const result = await handleHTTPRequest({
              url: args.url as string,
              method: args.method as string,
              headers: args.headers as Record<string, string> | undefined,
              body: args.body,
              params: args.params as Record<string, string> | undefined,
              env: this.env,
            });

            if (result.error) {
              return {
                content: [
                  {
                    type: "text",
                    text: `HTTP请求失败 (${result.status || ""}): ${result.statusText || result.message || "未知错误"}\n\n${result.data ? JSON.stringify(result.data, null, 2) : ""}`,
                  },
                ],
              };
            }

            return {
              content: [
                { type: "text", text: JSON.stringify(result.data, null, 2) },
              ],
            };
          } catch (error) {
            console.error("HTTP request error:", error);

            return {
              content: [
                {
                  type: "text",
                  text: `HTTP请求失败: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
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
app.use(":projectId/v1/chat/completions", apiKeyMiddleware);  
app.post(":projectId/v1/chat/completions", async (c) => {
  try {
    const projectId = c.req.param("projectId");
    // If no token, return error

    // Create a Durable Object ID based on the token
    const chatId = c.env.Chat.idFromName(projectId);

    // Get the Durable Object stub
    const chatDO = c.env.Chat.get(chatId);
    // const body = await c.req.json();
    // const model = body.model;

    // Create a new request with custom headers
    const newRequest = new Request(c.req.url, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
    });

    // Pass token
    newRequest.headers.set("X-Custom-Token", projectId);

    // Forward the request to the Durable Object
    const response = await chatDO.fetch(newRequest);

    // Return the response from the Durable Object
    return new Response(response.body, response);
  } catch (error) {
    // Handle any unexpected errors
    console.error("Error routing chat request:", error);
    return c.json(
      {
        error: {
          message: "Failed to route chat request",
          type: "server_error",
          code: "processing_error",
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500
    );
  }
});

app.post(
  "/v1/rag/pinecone",
  zValidator(
    "json",
    z.object({
      query: z.string(),
      modelId: z.string().default("text-embedding-3-small"),
      pineconeApiKey: z.string(),
      indexName: z.string(),
      topK: z.number().default(10),
    }),
    (result, c) => {
      if (!result.success) {
        return c.text("Invalid!", 400);
      }
    }
  ),
  async (c) => {
    const data = c.req.valid("json");
    const { query, modelId, pineconeApiKey, indexName, topK } = data;
    try {
      const { embedding } = await embed({
        value: query,
        model: openai.embedding(modelId),
      });
      const store = new PineconeVector({
        apiKey: pineconeApiKey,
      });
      const results = await store.query({
        indexName: indexName,
        queryVector: embedding,
        topK: topK,
      });
      return c.json(results);
    } catch (error) {
      return c.json(
        {
          error: {
            message: "error",
            type: "server_error",
          },
        },
        500
      );
    }
  }
);

app.get("/rag/doc", async (c) => {
  const document = createDocument({
    openapi: "3.1.0",
    info: {
      title: "rag API",
      version: "1.0.0",
    },
    paths: {
      "/v1/rag/pinecone": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: z.object({
                  query: z.string().openapi({ description: "query text" }),
                  modelId: z
                    .string()
                    .default("text-embedding-3-small")
                    .openapi({ description: "OpenAI embedding model" }),
                  pineconeApiKey: z
                    .string()
                    .openapi({ description: "pinecone api key" }),
                  indexName: z.string().openapi({ description: "index name" }),
                  topK: z
                    .number()
                    .default(10)
                    .openapi({ description: "top k" }),
                }),
              },
            },
          },
          responses: {
            "200": {
              description: "200 OK",
              content: {
                "application/json": {
                  schema: z.object({
                    results: z.array(
                      z.object({
                        text: z.string(),
                        score: z.number(),
                        metadata: z.object({
                          source: z.string(),
                        }),
                      })
                    ),
                  }),
                },
              },
            },
          },
        },
      },
    },
  });
  return c.json(document);
});
app.mount("/", (req, env, ctx) => {
  // 从 headers 获取认证信息
  let authHeader = req.headers.get("authorization");

  // 从 URL 参数获取认证信息
  const url = new URL(req.url);
  const authParam = url.searchParams.get("authorization");

  // 优先使用 URL 参数
  if (authParam) {
    authHeader = authParam.startsWith("Bearer ")
      ? authParam
      : `Bearer ${authParam}`;
  }

  console.log(authHeader, "authHeader");

  // 设置props
  ctx.props = {};

  if (authHeader) {
    ctx.props.bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.substring(7)
      : authHeader;
  }

  return MyMCP.mount("/sse").fetch(req, env, ctx);
});



// Chat endpoint

// app.get('/test', async (c) => {

//   const userId = c.get("userId")
//   if (!userId) {
//     return c.json({
//       error: {
//         message: 'Authentication error:  API Key is invalid',
//         type: 'authentication_error',
//         code: 'invalid_parameters'
//       }
//     }, 401);
//   }
//   const cost = 1
//   const apiKeyManager = getApiKeyManager(c.env as any)
//   const projectId = c.env.PROJECT_ID
//   await apiKeyManager.verifyKey({
//     userId,
//     cost,
//     projectId
//   })
//   return c.json({
//     message: 'test',
//     userId
//   })
// })
// Export the default Hono app
export default {
  fetch: app.fetch.bind(app),
};
