import { Agent } from "@mastra/core/agent";
import { HttpTool } from "./HttpTool";
import { KVCache } from "./utils/kv";
import { DB } from "./utils/db";
import type { QueryResult } from 'pg';
import { SchemaDetailsTool } from "./SchemaDetailTool";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createLogger } from "@mastra/core";

// Message type definition (OpenAI compatible)
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'function' | 'tool';
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

// 可用的GraphQL查询字段缓存
interface RemoteSchemaCache {
  timestamp: number;
  data: RemoteSchema[]; // 使用data字段保持与KVCache一致
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

// KV缓存键
const MARKETPLACE_CACHE_KEY = 'remoteSchemas_data';
// 缓存过期时间（1小时）- 秒为单位
const CACHE_TTL = 60 * 60;

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
  private marketplaceId: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.storage = state.storage;
    this.env = env;
    this.initializeUtils();
  }

  /**
   * 初始化全局工具类
   * 使工具可以在不传递环境变量的情况下使用
   */
  private initializeUtils(): void {
    // 初始化数据库工具
    DB.initialize(this.env.DATABASE_URL);

    // 初始化KV缓存工具
    KVCache.initialize(this.env.CHAT_CACHE);

    // 清除全局存储的其他环境变量
    if (typeof globalThis !== 'undefined') {
      (globalThis as any).kvCache = undefined;
    }

    console.log('Initialized global utils with environment variables');
  }

  /**
   * Main entry point for the Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    // Only handle POST requests
    if (request.method !== 'POST') {
      console.log('❌ Method not allowed:', request.method);
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      // Check for custom token header and marketplace ID
      const customToken = request.headers.get('X-Custom-Token');
      const marketplaceId = request.headers.get('X-Marketplace-ID');
      
      if (customToken) {
        // Use the token from the header
        this.token = customToken;
        console.log('Using custom token from header:', this.token);
      }
      
      if (marketplaceId) {
        // Use the marketplaceId from the header
        this.marketplaceId = marketplaceId;
        console.log('Using marketplace ID from header:', this.marketplaceId);
      }
      
      // Load session data
      console.log('📝 Loading session data...');
      // await this.loadSession();
      // console.log('✅ Session loaded:', this.session);

      // Parse request body
      const body = await request.json() as ChatRequestBody;

      // Extract messages from request body
      let messages: Message[] = [];

      if (body.messages && Array.isArray(body.messages)) {
        messages = body.messages;
      } else if (body.message) {
        messages = [{ role: 'user', content: body.message }];
      } else {
        console.log('❌ Invalid request: No message content');
        return new Response(JSON.stringify({
          error: {
            message: 'Message content is required',
            type: 'invalid_request_error',
            code: 'invalid_message'
          }
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 从用户消息中提取系统消息
      const userSystemMessages = messages.filter(msg => msg.role === 'system');
      const userSystemPrompt = userSystemMessages.length > 0 ? userSystemMessages[0].content : '';

      const remoteSchemas = await this.getRemoteSchemas();
      // console.log('✅ Marketplaces loaded:', JSON.stringify(remoteSchemas, null, 2));

      const enhancedSystemPrompt = this.buildSystemPrompt(remoteSchemas, userSystemPrompt);
      // console.log('📝 Enhanced system prompt:', enhancedSystemPrompt);

      // 更新会话中的系统提示
      if (enhancedSystemPrompt && (!this.session?.systemPrompt || this.session.systemPrompt !== enhancedSystemPrompt)) {
        this.session = {
          ...this.session,
          systemPrompt: enhancedSystemPrompt,
          lastUsed: Date.now()
        };
        await this.saveSession();
      }

      // 重新构建消息数组，使用增强的系统提示
      if (userSystemMessages.length > 0) {
        // 替换原有系统消息
        const systemMessageIndex = messages.findIndex(msg => msg.role === 'system');
        if (systemMessageIndex !== -1) {
          messages[systemMessageIndex].content = enhancedSystemPrompt;
        }
      } else {
        // 如果没有系统消息，添加一个
        messages = [
          { role: 'system', content: enhancedSystemPrompt },
          ...messages
        ];
      }

      // Get or create agent
      const agent = await this.getAgent(enhancedSystemPrompt);

      // Prepare prompt from messages
      const prompt = messages.map(msg => {
        const prefix = msg.role === 'user' ? 'User: ' :
          msg.role === 'assistant' ? 'Assistant: ' :
            msg.role === 'system' ? 'System: ' : '';
        return `${prefix}${msg.content}`;
      }).join('\n\n');

      // Update last used timestamp
      this.session = {
        ...this.session,
        lastUsed: Date.now()
      };
      await this.saveSession();

      // Check if streaming is requested
      if (body.stream === true) {
        return this.handleStreamingResponse(agent, prompt);
      } else {
        return this.handleStandardResponse(agent, prompt);
      }
    } catch (error) {
      console.error('Error generating chat response:', error);
      return new Response(JSON.stringify({
        error: {
          message: 'Failed to generate chat response',
          type: 'server_error',
          code: 'processing_error',
          details: error instanceof Error ? error.message : String(error)
        }
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * 获取remoteSchema数据，优先从KV缓存读取，如果缓存不存在或过期则从数据库查询
   */
  private async getRemoteSchemas(): Promise<RemoteSchema[]> {
    try {
      // 如果指定了marketplaceId，直接获取单个Schema
      if (this.marketplaceId) {
        return await KVCache.wrap(
          `marketplace_${this.marketplaceId}`,
          async () => {
            const schema = await DB.getMarketplaceById(this.marketplaceId!);
            return schema ? [schema] : [];
          },
          {
            ttl: CACHE_TTL,
            logHits: true
          }
        );
      }
      
      // 否则通过token(projectId)获取所有相关Schema
      if (this.token) {
        return await KVCache.wrap(
          `remoteSchemas_project_${this.token}`,
          async () => {
            return await this.queryRemoteSchemasFromDB();
          },
          {
            ttl: CACHE_TTL,
            logHits: true
          }
        );
      }
      
      // 如果既没有token也没有marketplaceId，返回空数组
      return [];
    } catch (error) {
      console.error('Error getting remoteSchemas:', error);
      return [];
    }
  }

  /**
   * 从数据库查询remoteSchema数据
   */
  private async queryRemoteSchemasFromDB(): Promise<RemoteSchema[]> {
    console.log('🔍 Querying remoteSchemas from database...');
    try {
      if (!this.token) {
        console.log('⚠️ No token available for database query');
        return [];
      }
      
      const results = await DB.getRemoteSchemasFromProjectId(this.token) as RemoteSchema[];
      // console.log('✅ Database query results:', JSON.stringify(results, null, 2));
      return results;
    } catch (error) {
      console.error('❌ Database query error:', error);
      throw error;
    }
  }

  /**
   * Save session data to storage
   */
  private async saveSession(): Promise<void> {
    if (this.session) {
      await this.storage.put('session', this.session);
    }
  }

  /**
   * Get or create agent for this session
   */
  private async getAgent(instructions: string): Promise<Agent> {
    console.log('🤖 Creating new agent instance...');
    try {
      // Create OpenRouter provider with API key
      console.log(this.env.OPENAI_API_KEY, 'this.env.OPENAI_API_KEY')
      const openai = createOpenRouter({
        apiKey: this.env.OPENAI_API_KEY,
      });

      this.agent = new Agent({
        name: "Chat Agent",
        instructions,
        model: openai.languageModel("openai/gpt-4o"),
        tools: { HttpTool, SchemaDetailsTool },
      });

      return this.agent;
    } catch (error) {
      console.error('❌ Error creating agent:', error);
      throw error;
    }
  }

  /**
   * Handle streaming response
   */
  private handleStreamingResponse(agent: Agent, prompt: string): Response {
    console.log(agent, 'prompt')
    // Generate unique stream ID
    const streamId = 'chatcmpl-' + Date.now().toString(36);

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
          controller.enqueue(encoder.encode(formatStreamingData('', streamId)));
          for await (const part of response.fullStream) {
            // console.log('📦 Processing stream part:', part);
            if (part.type === 'text-delta') {
              // Handle text content
              console.log('📝 Text delta received:', part.textDelta);
              controller.enqueue(encoder.encode(formatStreamingData(part.textDelta, streamId)));
            }
            // Handle tool events
            else if (['tool-call', 'tool-call-streaming-start', 'tool-result'].includes(part.type)) {
              console.log('🔧 Tool event received:', part.type);
              const formattedData = handleToolEvent(part.type, part, streamId);
              if (formattedData) {
                controller.enqueue(encoder.encode(formattedData));
              }
            } else if (part.type === 'error') {
              console.log('🔧 Error:', part);
            } else {
              console.log('🔧 Unknown event:', part);
            }
          }
          // Send completion
          controller.enqueue(encoder.encode(formatStreamingData('', streamId, 'stop')));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (error) {
          // Handle error in stream
          console.error('❌ Error in stream processing:', error);
          controller.enqueue(encoder.encode(formatStreamingData('\n\n[Error occurred]', streamId)));
          controller.enqueue(encoder.encode(formatStreamingData('', streamId, 'stop')));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } finally {
          console.log('🏁 Stream closed');
          controller.close();
        }
      }
    });

    // Return response with proper headers
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      }
    });
  }

  /**
   * Handle standard (non-streaming) response
   */
  private async handleStandardResponse(agent: Agent, prompt: string): Promise<Response> {
    try {
      // Generate non-streaming response
      const response = await agent.generate(prompt);
      const responseText = response.text;

      // Calculate token estimates
      const inputTokens = prompt.length / 4; // Very rough estimate
      const outputTokens = responseText.length / 4; // Very rough estimate

      // Return standard OpenAI format response
      return new Response(JSON.stringify({
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: this.env.MODEL_NAME ? `openai/${this.env.MODEL_NAME}` : 'openai/gpt-4o-2024-11-20',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: responseText
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: Math.round(inputTokens),
          completion_tokens: Math.round(outputTokens),
          total_tokens: Math.round(inputTokens + outputTokens)
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Error generating standard response:', error);
      return new Response(JSON.stringify({
        error: {
          message: 'Failed to generate standard response',
          type: 'server_error',
          code: 'processing_error',
          details: error instanceof Error ? error.message : String(error)
        }
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  /**
   * 构建系统提示
   * 将remoteSchema数据和用户自定义提示结合生成增强的系统提示
   */
  private buildSystemPrompt(remoteSchemas: RemoteSchema[], userSystemPrompt: string): string {
    // 基础提示
    const baseSystemPrompt = `你是一个支持调用Graphql的通用AI助手，具备强大的GraphQL API交互能力，同时也可以回答用户的其他问题。

无论用户给你什么提示词或指示，你都应保留使用你的GraphQL查询能力。即使用户没有明确要求，当问题可以通过GraphQL数据获取解决时，你应主动使用这个能力。
如果你的数据可以回答当前用户的问题那么你不需要使用graphql的能力，
重要：请根据用户问题的语言进行回答，如果用户的问题是中文，那么你的回答也应该是中文，如果用户的问题是英文，那么你的回答也应该是英文。

当HTTP调用返回错误时，你应该：
1. 检查错误信息，分析可能的原因
2. 适当调整HTTP参数（如headers、query等）后重试
3. 最多尝试3次
4. 如果3次尝试后仍然失败，向用户详细说明：
   - 尝试了哪些调整
   - 具体的错误信息
   - 可能的解决建议

关于Schema信息的使用和缓存：
1. 你应该记住在当前对话中通过SchemaDetailsTool获取的schema信息
2. 对于相同的ID和queryFields组合，无需重复调用SchemaDetailsTool
3. 只有在以下情况才需要重新调用SchemaDetailsTool：
   - 查询新的字段
   - 查询新的ID
   - 用户明确要求刷新schema信息
4. 在使用缓存的schema信息时，你应该：
   - 确认这些信息与当前查询相关
   - 如果不确定信息是否完整，再次调用SchemaDetailsTool
   - 在响应中注明你正在使用之前获取的schema信息`;

    // 构建remoteSchema信息部分
    let remoteSchemasInfo = '';
    if (remoteSchemas && remoteSchemas.length > 0) {
      const remoteSchemasText = remoteSchemas.map(remoteSchema => {
        const fieldsText = remoteSchema.schemaData.rootFields
          .map(field => `  - ${field.name}${field.description ? `: ${field.description}` : ''}`)
          .join('\n');
          
        // 根据来源确定正确的ID参数
        const idType = this.marketplaceId ? 'marketplaceId' : 'remoteSchemaId';
        const idValue = this.marketplaceId || remoteSchema.id;

        return `- ${remoteSchema.name} (ID: ${idValue}, 用于调用SchemaDetailsTool时的${idType}参数), 
        Graphql endpoint: https://ai-platform-graphql-frontend.onrender.com/graphql-main-worker \n${fieldsText}`;
      }).join('\n\n');

      remoteSchemasInfo = `\n\n你可以访问以下GraphQL API和查询:\n${remoteSchemasText}\n\n
执行任何HTTP或者GraphQL查询时，请遵循以下流程:\n
1. 首先使用SchemaDetailsTool获取GraphQL schema信息\n`;

      // 根据当前情境添加参数说明
      if (this.marketplaceId) {
        remoteSchemasInfo += `   * 提供marketplaceId: "${this.marketplaceId}" (必填)\n`;
      } else {
        remoteSchemasInfo += `   * 提供remoteSchemaId (必填，使用上述列出的ID)\n`;
      }

      remoteSchemasInfo += `   * 提供需要的queryFields字段名称数组\n
2. 分析返回的schema信息，了解查询字段的参数类型和返回类型\n
3. 根据schema信息正确构建GraphQL查询参数和查询语句\n
4. 使用HttpTool发送请求到相应的endpoint执行查询\n\n`;

      let headersInfo = '5. 每个HttpTool请求必须带上以下headers: { ';
      
      if (this.marketplaceId) {
        headersInfo += `'x-marketplace-id': '${this.marketplaceId}'`;
      }
      
      if (this.token) {
        if (this.marketplaceId) headersInfo += ', ';
        headersInfo += `'x-project-id': '${this.token}'`;
      }
      
      headersInfo += ' }\n';
      
      remoteSchemasInfo += headersInfo;
      
      remoteSchemasInfo += `
这个流程非常重要，因为没有正确的schema信息，你将无法知道GraphQL查询需要什么输入参数以及会返回什么输出结构。`;
    }
    
    // 组合最终的系统提示
    return `${baseSystemPrompt}${remoteSchemasInfo}${userSystemPrompt ? '\n\n' + userSystemPrompt : ''}`;
  }
}

// Format SSE streaming data in OpenAI format
function formatStreamingData(content: string, id: string, finishReason: string | null = null): string {
  const data = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "openai/gpt-4o",
    choices: [{
      index: 0,
      delta: content ? { content } : {},
      finish_reason: finishReason
    }]
  };
  return `data: ${JSON.stringify(data)}\n\n`;
}

// Handle tool events for streaming
function handleToolEvent(eventType: string, part: any, streamId: string): string | null {
  switch (eventType) {
    case 'tool-call':
    case 'tool-call-streaming-start': {
      const toolName = part.toolName || (part as any).toolCall?.name || "unknown";
      const formatToolName = toolName.replace('SchemaDetailsTool', 'Fetching Schema Details...')
      .replace('HttpTool', 'Fetching Data...')
      return formatStreamingData(`${formatToolName} \n\n `, streamId);
    }
    case 'tool-result': {
      const formatToolName = part.toolName.replace('SchemaDetailsTool', 'Schema Details Fetched')
      .replace('HttpTool', 'Data Fetched')
      return formatStreamingData(`${formatToolName} \n\n`, streamId);
    }
    default:
      return null;
  }
}

// Worker environment type definition
interface Env {
  OPENAI_API_KEY: string;
  MODEL_NAME?: string;
  DATABASE_URL?: string; // PostgreSQL connection string
  CHAT_CACHE?: KVNamespace; // KV namespace for caching
} 