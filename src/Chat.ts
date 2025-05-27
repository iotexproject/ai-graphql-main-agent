import { Agent } from "@mastra/core/agent";
import { HttpTool } from "./HttpTool";
import { KVCache } from "./utils/kv";
import { DB } from "./utils/db";
import { SchemaDetailsTool } from "./SchemaDetailTool";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

// Message type definition (OpenAI compatible)
export interface Message {
  role: "system" | "user" | "assistant" | "function" | "tool";
  content: string;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

// Chat session data stored in DO
interface ChatSession {
  systemPrompt?: string;
  lastUsed: number;
  // We don't store the agent instance itself as it's not serializable
  // Instead we'll recreate it when needed
}

// Marketplace entity definition based on Remult entity
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

// Available GraphQL query fields cache
interface RemoteSchemaCache {
  timestamp: number;
  data: RemoteSchema[]; // Using data field to stay consistent with KVCache
}

// Request body interface for OpenAI-compatible API
export interface ChatRequestBody {
  messages?: Message[];
  message?: string;
  stream?: boolean;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  projectId?: string; // For backward compatibility
  [key: string]: any; // Allow other properties
}

// KV cache key
const MARKETPLACE_CACHE_KEY = "remoteSchemas_data";
// Cache expiration time (1 hour) - in seconds
const CACHE_TTL = 60;

/**
 * Chat Durable Object
 * Handles persistent chat sessions across worker instances
 */
export class Chat {
  private storage: DurableObjectStorage;
  private env: Env;
  private session: ChatSession | null = null;
  private agent: Agent | null = null;
  private token: string | null = null;
  private request: Request | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.storage = state.storage;
    this.env = env;
    this.initializeUtils();
  }

  /**
   * Initialize global utility classes
   * Allow tools to be used without passing environment variables
   */
  private initializeUtils(): void {
    // Initialize database tools
    DB.initialize(this.env.DATABASE_URL);

    // Initialize KV cache tools
    KVCache.initialize(this.env.CHAT_CACHE);

    // Clear other environment variables stored globally
    if (typeof globalThis !== "undefined") {
      (globalThis as any).kvCache = undefined;
    }

    console.log("Initialized global utils with environment variables");
  }

  /**
   * Main entry point for the Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    // Store the request for later use
    this.request = request;

    // Only handle POST requests
    if (request.method !== "POST") {
      console.log("❌ Method not allowed:", request.method);
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      // Check for custom token header
      const customToken = request.headers.get("X-Custom-Token");

      if (customToken) {
        // Use the token from the header
        this.token = customToken;
        console.log("Using custom token from header:", this.token);
      }

      // Load session data
      console.log("📝 Loading session data...");
      // await this.loadSession();
      // console.log('✅ Session loaded:', this.session);

      // Parse request body
      const body = (await request.json()) as ChatRequestBody;

      // Extract messages from request body
      let messages: Message[] = [];

      if (body.messages && Array.isArray(body.messages)) {
        messages = body.messages;
      } else if (body.message) {
        messages = [{ role: "user", content: body.message }];
      } else {
        console.log("❌ Invalid request: No message content");
        return new Response(
          JSON.stringify({
            error: {
              message: "Message content is required",
              type: "invalid_request_error",
              code: "invalid_message",
            },
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // 从用户消息中提取系统消息
      const userSystemMessages = messages.filter(
        (msg) => msg.role === "system"
      );
      const userSystemPrompt =
        userSystemMessages.length > 0 ? userSystemMessages[0].content : "";

      const remoteSchemas = await this.getRemoteSchemas();

      // console.log('✅ Marketplaces loaded:', JSON.stringify(remoteSchemas, null, 2));

      const enhancedSystemPrompt = this.buildSystemPrompt(
        remoteSchemas,
        userSystemPrompt
      );
      // console.log('📝 Enhanced system prompt:', enhancedSystemPrompt);

      // 更新会话中的系统提示
      if (
        enhancedSystemPrompt &&
        (!this.session?.systemPrompt ||
          this.session.systemPrompt !== enhancedSystemPrompt)
      ) {
        this.session = {
          ...this.session,
          systemPrompt: enhancedSystemPrompt,
          lastUsed: Date.now(),
        };
        await this.saveSession();
      }

      // 重新构建消息数组，使用增强的系统提示
      if (userSystemMessages.length > 0) {
        // 替换原有系统消息
        const systemMessageIndex = messages.findIndex(
          (msg) => msg.role === "system"
        );
        if (systemMessageIndex !== -1) {
          messages[systemMessageIndex].content = enhancedSystemPrompt;
        }
      } else {
        // 如果没有系统消息，添加一个
        messages = [
          { role: "system", content: enhancedSystemPrompt },
          ...messages,
        ];
      }

      // Get or create agent
      const agent = await this.getAgent(enhancedSystemPrompt);

      // Prepare prompt from messages
      const prompt = messages
        .map((msg) => {
          const prefix =
            msg.role === "user"
              ? "User: "
              : msg.role === "assistant"
                ? "Assistant: "
                : msg.role === "system"
                  ? "System: "
                  : "";
          return `${prefix}${msg.content}`;
        })
        .join("\n\n");

      // Update last used timestamp
      this.session = {
        ...this.session,
        lastUsed: Date.now(),
      };
      await this.saveSession();

      // Check if streaming is requested
      if (body.stream === true) {
        return this.handleStreamingResponse(agent, prompt);
      } else {
        return this.handleStandardResponse(agent, prompt);
      }
    } catch (error) {
      console.error("Error generating chat response:", error);
      return new Response(
        JSON.stringify({
          error: {
            message: "Failed to generate chat response",
            type: "server_error",
            code: "processing_error",
            details: error instanceof Error ? error.message : String(error),
          },
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  }

  /**
   * Get remoteSchema data, prioritizing KV cache, querying database if cache doesn't exist or is expired
   */
  private async getRemoteSchemas(): Promise<RemoteSchema[]> {
    try {
      // Get all related Schemas through token (projectId)
      if (this.token) {
        return await KVCache.wrap(
          `remoteSchemas_project_v6_${this.token}`,
          async () => {
            return await this.queryRemoteSchemasFromDB();
          },
          {
            ttl: CACHE_TTL,
            logHits: true,
          }
        );
      }

      // If token doesn't exist, return empty array
      return [];
    } catch (error) {
      console.error("Error getting remoteSchemas:", error);
      return [];
    }
  }

  /**
   * Query remoteSchema data from database
   */
  private async queryRemoteSchemasFromDB(): Promise<RemoteSchema[]> {
    console.log("🔍 Querying remoteSchemas from database...");
    try {
      if (!this.token) {
        console.log("⚠️ No token available for database query");
        return [];
      }

      const results = (await DB.getRemoteSchemasFromProjectId(
        this.token
      )) as RemoteSchema[];
      console.log(
        "✅ Database query results:",
        this.token,
        JSON.stringify(results, null, 2)
      );
      return results;
    } catch (error) {
      console.error("❌ Database query error:", error);
      throw error;
    }
  }

  /**
   * Save session data to storage
   */
  private async saveSession(): Promise<void> {
    if (this.session) {
      await this.storage.put("session", this.session);
    }
  }

  /**
   * Get or create agent for this session
   */
  private async getAgent(instructions: string): Promise<Agent> {
    console.log("🤖 Creating new agent instance...");
    try {
      // Create OpenRouter provider with API key
      console.log(this.env.OPENROUTER_API_KEY, "this.env.OPENROUTER_API_KEY");
      const openai = createOpenRouter({
        apiKey: this.env.OPENROUTER_API_KEY,
        baseURL:
          "https://gateway.ai.cloudflare.com/v1/3f724e4b38a30ee9d189654b73a4e87e/quicksilver/openrouter",
      });

      this.agent = new Agent({
        name: "Chat Agent",
        instructions,
        //thinking model:qwen/qwen3-32b
        model: openai.languageModel("qwen/qwen-2.5-72b-instruct"),
        tools: { HttpTool, SchemaDetailsTool },
      });

      return this.agent;
    } catch (error) {
      console.error("❌ Error creating agent:", error);
      throw error;
    }
  }

  /**
   * Handle streaming response
   */
  private handleStreamingResponse(agent: Agent, prompt: string): Response {
    console.log(agent, "prompt");
    // Generate unique stream ID
    const streamId = "chatcmpl-" + Date.now().toString(36);

    // Check if tool events should be shown
    const showToolEvents = this.request?.headers.get("withToolEvent") !== null;

    // Stream response
    const responsePromise = agent.stream(prompt);

    // Create response stream
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        try {
          // Get the response
          const response = await responsePromise;
          // Send initial role message
          controller.enqueue(encoder.encode(formatStreamingData("", streamId)));
          for await (const part of response.fullStream) {
            // console.log('📦 Processing stream part:', part);
            if (part.type === "text-delta") {
              // Handle text content
              console.log("📝 Text delta received:", part.textDelta);
              controller.enqueue(
                encoder.encode(formatStreamingData(part.textDelta, streamId))
              );
            }
            // Handle tool events
            else if (
              [
                "tool-call",
                "tool-call-streaming-start",
                "tool-result",
              ].includes(part.type)
            ) {
              console.log("🔧 Tool event received:", part.type);
              const formattedData = handleToolEvent(
                part.type,
                part,
                streamId,
                showToolEvents
              );
              if (formattedData) {
                controller.enqueue(encoder.encode(formattedData));
              }
            } else if (part.type === "error") {
              console.log("🔧 Error:", part);
            } else {
              console.log("🔧 Unknown event:", part);
            }
          }
          // Send completion
          controller.enqueue(
            encoder.encode(formatStreamingData("", streamId, "stop"))
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (error) {
          // Handle error in stream
          console.error("❌ Error in stream processing:", error);
          controller.enqueue(
            encoder.encode(
              formatStreamingData("\n\n[Error occurred]", streamId)
            )
          );
          controller.enqueue(
            encoder.encode(formatStreamingData("", streamId, "stop"))
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } finally {
          console.log("🏁 Stream closed");
          controller.close();
        }
      },
    });

    // Return response with proper headers
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  /**
   * Handle standard (non-streaming) response
   */
  private async handleStandardResponse(
    agent: Agent,
    prompt: string
  ): Promise<Response> {
    try {
      // Generate non-streaming response
      const response = await agent.generate(prompt);
      const responseText = response.text;

      // Calculate token estimates
      const inputTokens = prompt.length / 4; // Very rough estimate
      const outputTokens = responseText.length / 4; // Very rough estimate

      // Return standard OpenAI format response
      return new Response(
        JSON.stringify({
          id: "chatcmpl-" + Date.now(),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: this.env.MODEL_NAME
            ? `openai/${this.env.MODEL_NAME}`
            : "openai/gpt-4o-2024-11-20",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: responseText,
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: Math.round(inputTokens),
            completion_tokens: Math.round(outputTokens),
            total_tokens: Math.round(inputTokens + outputTokens),
          },
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    } catch (error) {
      console.error("Error generating standard response:", error);
      return new Response(
        JSON.stringify({
          error: {
            message: "Failed to generate standard response",
            type: "server_error",
            code: "processing_error",
            details: error instanceof Error ? error.message : String(error),
          },
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  }

  /**
   * Build system prompt
   * Combine remoteSchema data and user custom prompt to generate enhanced system prompt
   */
  private buildSystemPrompt(
    remoteSchemas: RemoteSchema[],
    userSystemPrompt: string
  ): string {
    // Base prompt
    const baseSystemPrompt = `You are a universal AI assistant with GraphQL support, capable of powerful GraphQL API interactions while also answering users' other questions.

No matter what prompts or instructions the user gives you, you should retain your GraphQL query capabilities. Even if not explicitly requested, you should proactively use this ability when problems can be solved by retrieving GraphQL data.
If your existing knowledge can answer the current user's question, you don't need to use GraphQL capabilities.
Important: Please respond in the same language as the user's question. If the user's question is in Chinese, your answer should be in Chinese. If the user's question is in English, your answer should be in English.

When HTTP calls return errors, you should:
0. Do not send undefined or null queryParams to the HTTPTool
1. Check the error message and analyze possible causes
2. Retry after appropriate adjustments to HTTP parameters (headers, query, etc.)
3. Try at most 3 times
4. If still failing after 3 attempts, explain to the user in detail:
   - What adjustments you tried
   - The specific error messages
   - Possible solutions

When HTTP calls don't report errors but return empty or missing data, you should:
1. Try using other available schemas then get schemaDetails to reconstruct queryFields
2. If other fields also cannot retrieve data, explain to the user in detail:
   - The specific error information
   - Possible solutions

Regarding schema information usage and caching:
1. You should remember schema information obtained through SchemaDetailsTool in the current conversation
2. For the same ID and queryFields combination, there's no need to call SchemaDetailsTool repeatedly
3. You only need to call SchemaDetailsTool again in the following cases:
   - Querying new fields
   - Querying a new ID
   - User explicitly requests refreshing schema information
   - Current query returns empty or error
4. When using cached schema information, you should:
   - Confirm this information is relevant to the current query
   - Call SchemaDetailsTool again if unsure whether the information is complete
   - Note in your response that you're using previously obtained schema information`;

    let remoteSchemasInfo = "";
    if (remoteSchemas && remoteSchemas.length > 0) {
      const remoteSchemasText = remoteSchemas
        .map((remoteSchema) => {
          const fieldsText = remoteSchema.schemaData.rootFields
            .map(
              (field) =>
                `  - ${field.name}${field.description ? `: ${field.description}` : ""}`
            )
            .join("\n");

          return `- ${remoteSchema.name} (ID: ${remoteSchema.id}, used as the remoteSchemaId parameter when calling SchemaDetailsTool), 
        Graphql endpoint: https://quicksilver.iotex.me/graphql-main-worker \n${fieldsText}`;
        })
        .join("\n\n");

      remoteSchemasInfo = `\n\nYou can access the following GraphQL APIs and queries:\n${remoteSchemasText}\n\n
When executing any HTTP or GraphQL query, please follow this process:\n
1. First use SchemaDetailsTool to get GraphQL schema information\n
   * Provide remoteSchemaId (required, use the IDs listed above)\n
   * Provide an array of queryFields field names that you need\n
2. Analyze the returned schema information to understand the parameter types and return types of query fields\n
3. Correctly build GraphQL query parameters and statements based on schema information\n
4. Use HttpTool to send requests to the corresponding endpoint to execute queries,
Do not carry both x-project-id and remoteSchemaId to the header at the same time. If x-project-id is available, use x-project-id first\n\n
When use HttpTool,Do not put the headers in the body`;

      let headersInfo =
        "5. Each HttpTool request must include the following headers: { ";

      if (this.token) {
        headersInfo += `'x-project-id': '${this.token}'`;
      }

      headersInfo += " }\n";

      remoteSchemasInfo += headersInfo;

      remoteSchemasInfo += `
This process is very important because without the correct schema information, you won't know what input parameters GraphQL queries require and what output structures they will return.`;
    }

    // Combine final system prompt
    return `${baseSystemPrompt}${remoteSchemasInfo}${userSystemPrompt ? "\n\n" + userSystemPrompt : ""}`;
  }
}

// Format SSE streaming data in OpenAI format
function formatStreamingData(
  content: string,
  id: string,
  finishReason: string | null = null
): string {
  const data = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "openai/gpt-4o",
    choices: [
      {
        index: 0,
        delta: content ? { content } : {},
        finish_reason: finishReason,
      },
    ],
  };
  return `data: ${JSON.stringify(data)}\n\n`;
}

// Handle tool events for streaming
function handleToolEvent(
  eventType: string,
  part: any,
  streamId: string,
  showToolEvents: boolean = false
): string | null {
  // Only process tool events if showToolEvents is true
  if (!showToolEvents) {
    return null;
  }

  switch (eventType) {
    case "tool-call":
    case "tool-call-streaming-start": {
      const toolName =
        part.toolName || (part as any).toolCall?.name || "unknown";
      const formatToolName = toolName
        .replace("SchemaDetailsTool", "<SchemaDetailsToolStart>")
        .replace("HttpTool", "<HttpToolStart>");
      return formatStreamingData(`${formatToolName} \n\n `, streamId);
    }
    case "tool-result": {
      const formatToolName = part.toolName
        .replace("SchemaDetailsTool", "<SchemaDetailsToolEnd>")
        .replace("HttpTool", "<HttpToolEnd>");
      return formatStreamingData(`${formatToolName} \n\n`, streamId);
    }
    default:
      return null;
  }
}

// Worker environment type definition
interface Env {
  OPENROUTER_API_KEY: string;
  OPENAI_API_KEY: string;
  MODEL_NAME?: string;
  DATABASE_URL?: string; // PostgreSQL connection string
  CHAT_CACHE?: KVNamespace; // KV namespace for caching
}
