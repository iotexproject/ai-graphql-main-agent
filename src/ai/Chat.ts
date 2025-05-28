import { Agent } from "@mastra/core/agent";
import { HttpTool } from "./HttpTool";
import { KVCache } from "../utils/kv";
import { DB } from "../utils/db";
import { SchemaDetailsTool } from "./SchemaDetailTool";
import { getAI } from "../utils/ai";
import { createErrorResponse } from "../utils/stream";

// Environment interface for Cloudflare Workers
interface Env {
  OPENROUTER_API_KEY: string;
  OPENAI_API_KEY: string;
  MODEL_NAME?: string;
  DATABASE_URL?: string;
  CHAT_CACHE?: KVNamespace;
}

// Message type definition (OpenAI compatible)
export interface Message {
  role: "system" | "user" | "assistant" | "function" | "tool";
  content: string;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

// Chat session data stored in Durable Object
interface ChatSession {
  systemPrompt?: string;
  lastUsed: number;
}

// Remote schema entity definition
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

// Request body interface for OpenAI-compatible API
export interface ChatRequestBody {
  messages?: Message[];
  message?: string;
  stream?: boolean;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  projectId?: string;
  [key: string]: any;
}

// Constants
const CACHE_TTL = 60; // Cache TTL in seconds (1 hour)

/**
 * Chat Durable Object
 * Handles persistent chat sessions across worker instances
 */
export class Chat {
  private storage: DurableObjectStorage;
  private env: Env;
  private session: ChatSession | null = null;
  private agent: Agent | null = null;
  private projectId: string | null = null;
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
    DB.initialize(this.env.DATABASE_URL);
    KVCache.initialize(this.env.CHAT_CACHE);
    if (typeof globalThis !== "undefined") {
      (globalThis as any).kvCache = undefined;
    }
    console.log("Initialized global utils with environment variables");
  }

  /**
   * Main entry point for the Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    this.request = request;

    if (request.method !== "POST") {
      console.log("Method not allowed:", request.method);
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const projectId = request.headers.get("X-Project-Id");
      const isGlobalChat = request.headers.get("X-Global-Chat") === "true";
      
      if (projectId) {
        this.projectId = projectId;
        console.log("Using project ID from header:", this.projectId);
      }

      const body = (await request.json()) as ChatRequestBody;
      
      // Handle global chat logic within Durable Object
      if (isGlobalChat) {
        return await this.handleGlobalChatInDO(body);
      }
      
      // Regular project chat logic
      let messages: Message[] = [];

      if (body.messages && Array.isArray(body.messages)) {
        messages = body.messages;
      } else if (body.message) {
        messages = [{ role: "user", content: body.message }];
      } else {
        console.log("Invalid request: No message content");
        return createErrorResponse(body.stream === true, {
          message: "Message content is required",
          type: "invalid_request_error",
          code: "invalid_message",
          status: 400
        });
      }

      // Extract system messages from user input
      const userSystemMessages = messages.filter(msg => msg.role === "system");
      const userSystemPrompt = userSystemMessages.length > 0 ? userSystemMessages[0].content : "";

      const remoteSchemas = await this.getRemoteSchemas();
      const enhancedSystemPrompt = this.buildSystemPrompt(remoteSchemas, userSystemPrompt);

      // Update session with enhanced system prompt
      if (enhancedSystemPrompt &&
        (!this.session?.systemPrompt || this.session.systemPrompt !== enhancedSystemPrompt)) {
        this.session = {
          ...this.session,
          systemPrompt: enhancedSystemPrompt,
          lastUsed: Date.now(),
        };
        await this.saveSession();
      }

      // Rebuild messages array with enhanced system prompt
      if (userSystemMessages.length > 0) {
        const systemMessageIndex = messages.findIndex(msg => msg.role === "system");
        if (systemMessageIndex !== -1) {
          messages[systemMessageIndex].content = enhancedSystemPrompt;
        }
      } else {
        messages = [
          { role: "system", content: enhancedSystemPrompt },
          ...messages,
        ];
      }

      const agent = await this.getAgent(enhancedSystemPrompt);

      // Prepare prompt from messages
      const prompt = messages
        .map(msg => {
          const prefix = msg.role === "user" ? "User: " :
            msg.role === "assistant" ? "Assistant: " :
              msg.role === "system" ? "System: " : "";
          return `${prefix}${msg.content}`;
        })
        .join("\n\n");

      // Update last used timestamp
      this.session = {
        ...this.session,
        lastUsed: Date.now(),
      };
      await this.saveSession();

      // Handle streaming or standard response
      if (body.stream === true) {
        return this.handleStreamingResponse(agent, prompt);
      } else {
        return this.handleStandardResponse(agent, prompt);
      }
    } catch (error) {
      console.error("Error generating chat response:", error);
      return createErrorResponse(false, {
        message: "Failed to generate chat response",
        type: "server_error",
        code: "processing_error",
        status: 500
      });
    }
  }

  /**
   * Get remote schema data with caching
   */
  private async getRemoteSchemas(): Promise<RemoteSchema[]> {
    try {
      if (this.projectId) {
        return await KVCache.wrap(
          `remoteSchemas_project_v6_${this.projectId}`,
          async () => {
            return await this.queryRemoteSchemasFromDB();
          },
          {
            ttl: CACHE_TTL,
            logHits: true,
          }
        );
      }
      return [];
    } catch (error) {
      console.error("Error getting remoteSchemas:", error);
      return [];
    }
  }

  /**
   * Query remote schema data from database
   */
  private async queryRemoteSchemasFromDB(): Promise<RemoteSchema[]> {
    console.log("Querying remoteSchemas from database...");
    try {
      if (!this.projectId) {
        console.log("No project ID available for database query");
        return [];
      }

      const results = (await DB.getRemoteSchemasFromProjectId(this.projectId)) as RemoteSchema[];
      console.log("Database query results:", this.projectId, JSON.stringify(results, null, 2));
      return results;
    } catch (error) {
      console.error("Database query error:", error);
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
   * Get or create agent for this session with caching
   */
  private async getAgent(instructions: string): Promise<Agent> {
    console.log('Checking cached Agent...');
    try {
      const openai = getAI(this.env.OPENROUTER_API_KEY);
      this.agent = new Agent({
        name: "Chat Agent",
        instructions,
        model: openai.languageModel("qwen/qwen-2.5-72b-instruct"),
        tools: { HttpTool, SchemaDetailsTool },
      });
      return this.agent;
    } catch (error) {
      console.error('Error creating agent:', error);
      throw error;
    }
  }

  /**
   * Handle streaming response
   */
  private handleStreamingResponse(agent: Agent, prompt: string): Response {
    console.log(agent, "prompt");
    const streamId = "chatcmpl-" + Date.now().toString(36);
    const showToolEvents = this.request?.headers.get("withToolEvent") !== null;
    const responsePromise = agent.stream(prompt);

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        try {
          const response = await responsePromise;
          controller.enqueue(encoder.encode(formatStreamingData("", streamId)));

          for await (const part of response.fullStream) {
            if (part.type === "text-delta") {
              console.log("Text delta received:", part.textDelta);
              controller.enqueue(
                encoder.encode(formatStreamingData(part.textDelta, streamId))
              );
            }
            else if (["tool-call", "tool-call-streaming-start", "tool-result"].includes(part.type)) {
              console.log("Tool event received:", part.type);
              const formattedData = handleToolEvent(part.type, part, streamId, showToolEvents);
              if (formattedData) {
                controller.enqueue(encoder.encode(formattedData));
              }
            } else if (part.type === "error") {
              console.log("Error:", part);
            } else {
              console.log("Unknown event:", part);
            }
          }

          controller.enqueue(encoder.encode(formatStreamingData("", streamId, "stop")));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (error) {
          console.error("Error in stream processing:", error);
          controller.enqueue(encoder.encode(formatStreamingData("\n\n[Error occurred]", streamId)));
          controller.enqueue(encoder.encode(formatStreamingData("", streamId, "stop")));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } finally {
          console.log("Stream closed");
          controller.close();
        }
      },
    });

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
  private async handleStandardResponse(agent: Agent, prompt: string): Promise<Response> {
    try {
      const response = await agent.generate(prompt);
      const responseText = response.text;

      // Calculate token estimates
      const inputTokens = prompt.length / 4;
      const outputTokens = responseText.length / 4;

      return new Response(
        JSON.stringify({
          id: "chatcmpl-" + Date.now(),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: this.env.MODEL_NAME ? `openai/${this.env.MODEL_NAME}` : "openai/gpt-4o-2024-11-20",
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
      return createErrorResponse(false, {
        message: "Failed to generate standard response",
        type: "server_error",
        code: "processing_error",
        status: 500
      });
    }
  }

  /**
   * Build enhanced system prompt with GraphQL capabilities
   */
  private buildSystemPrompt(remoteSchemas: RemoteSchema[], userSystemPrompt: string): string {
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
            .map((field) => `  - ${field.name}${field.description ? `: ${field.description}` : ""}`)
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

      let headersInfo = "5. Each HttpTool request must include the following headers: { ";

      if (this.projectId) {
        headersInfo += `'x-project-id': '${this.projectId}'`;
      }

      headersInfo += " }\n";
      remoteSchemasInfo += headersInfo;

      remoteSchemasInfo += `
This process is very important because without the correct schema information, you won't know what input parameters GraphQL queries require and what output structures they will return.`;
    }

    return `${baseSystemPrompt}${remoteSchemasInfo}${userSystemPrompt ? "\n\n" + userSystemPrompt : ""}`;
  }

  /**
   * Handle global chat logic within Durable Object
   */
  private async handleGlobalChatInDO(body: ChatRequestBody): Promise<Response> {
    try {
      const requestMessages = body.messages || [];
      const isStream = body.stream === true;
      
      if (!requestMessages.length) {
        return createErrorResponse(isStream, {
          message: "Messages are required",
          type: "invalid_request_error",
          code: "invalid_parameters",
          status: 400
        });
      }
      
      const userMessage = requestMessages[requestMessages.length - 1]?.content || "";
      const publishedProjects = await DB.getPublishedProjects();
      console.log(publishedProjects, "publishedProjects");
      
      if (publishedProjects.length === 0) {
        // Use sora model logic here - we need to implement this in DO
        return await this.useSoraModelInDO(body);
      }
      
      const projectsInfo = publishedProjects.map(project =>
        `- Project ID: ${project.id}\n  Name: ${project.name}\n  Description: ${project.description || 'No description'}`
      ).join('\n\n');

      const selectionPrompt = `You are a smart project selector. Based on the available projects and user's question, select the most suitable project to answer the question. If no project is suitable, return "NONE".
Available Projects:
${projectsInfo}

User Question: ${userMessage}

Analysis Rules:
1. Match the user's question topic with project descriptions
2. Consider project names for relevance hints
3. Only select a project if it's clearly relevant to the question
4. If the question is too general or doesn't match any specific project capability, return "NONE"

Please return ONLY the Project ID or "NONE" (without quotes), no other text.`;

      console.log(selectionPrompt, "selectionPrompt");
      const { generateText } = await import("ai");
      const openrouter = getAI(this.env.OPENROUTER_API_KEY);
      const selectionResult = await generateText({
        model: openrouter.languageModel("qwen/qwen-2.5-72b-instruct"),
        prompt: selectionPrompt,
        temperature: 0.1,
        maxTokens: 50,
      });
      
      const selectedProjectId = selectionResult.text.trim();
      console.log(selectedProjectId, "selectionResult");
      
      if (selectedProjectId === "NONE" || !publishedProjects.find(p => p.id === selectedProjectId)) {
        console.log("No suitable project found, using sora model");
        return await this.useSoraModelInDO(body);
      }

      console.log(`Selected project: ${selectedProjectId}`);
      
      // Switch to the selected project's context
      this.projectId = selectedProjectId;
      
      // Process the request as a regular project chat
      const processMessages: Message[] = body.messages || [];
      if (body.message && !body.messages) {
        processMessages.push({ role: "user", content: body.message });
      }

      const remoteSchemas = await this.getRemoteSchemas();
      const enhancedSystemPrompt = this.buildSystemPrompt(remoteSchemas, "");

      const agent = await this.getAgent(enhancedSystemPrompt);
      const prompt = processMessages
        .map(msg => {
          const prefix = msg.role === "user" ? "User: " :
                        msg.role === "assistant" ? "Assistant: " :
                        msg.role === "system" ? "System: " : "";
          return `${prefix}${msg.content}`;
        })
        .join("\n\n");

      if (body.stream === true) {
        return this.handleStreamingResponse(agent, prompt);
      } else {
        return this.handleStandardResponse(agent, prompt);
      }
    } catch (error) {
      console.error("Error in global chat within DO:", error);
      return createErrorResponse(false, {
        message: "Failed to process global chat request",
        type: "server_error",
        code: "processing_error",
        status: 500
      });
    }
  }

  /**
   * Use Sora model within Durable Object
   */
  private async useSoraModelInDO(body: ChatRequestBody): Promise<Response> {
    try {
      const messages = body.messages || [];
      const prompt = messages
        .map(msg => {
          const prefix = msg.role === "user" ? "User: " :
                        msg.role === "assistant" ? "Assistant: " :
                        msg.role === "system" ? "System: " : "";
          return `${prefix}${msg.content}`;
        })
        .join("\n\n");

      const openrouter = getAI(this.env.OPENROUTER_API_KEY);
      
      if (body.stream === true) {
        const { streamText } = await import("ai");
        const result = await streamText({
          model: openrouter.languageModel("qwen/qwen-2.5-72b-instruct"),
          prompt: prompt,
        });

        const streamId = "chatcmpl-" + Date.now().toString(36);
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(formatStreamingData("", streamId)));
            
            try {
              for await (const delta of result.textStream) {
                controller.enqueue(encoder.encode(formatStreamingData(delta, streamId)));
              }
              controller.enqueue(encoder.encode(formatStreamingData("", streamId, "stop")));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } catch (error) {
              console.error("Error in sora stream:", error);
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        });
      } else {
        const { generateText } = await import("ai");
        const result = await generateText({
          model: openrouter.languageModel("qwen/qwen-2.5-72b-instruct"),
          prompt: prompt,
        });

        return new Response(
          JSON.stringify({
            id: "chatcmpl-" + Date.now(),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "openai/gpt-4o",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: result.text,
                },
                finish_reason: "stop",
              },
            ],
          }),
          {
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    } catch (error) {
      console.error("Error in sora model:", error);
      return createErrorResponse(body.stream === true, {
        message: "Failed to generate response with Sora model",
        type: "server_error",
        code: "processing_error",
        status: 500
      });
    }
  }
}

/**
 * Format SSE streaming data in OpenAI format
 */
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

/**
 * Handle tool events for streaming response
 */
function handleToolEvent(
  eventType: string,
  part: any,
  streamId: string,
  showToolEvents: boolean = false
): string | null {
  if (!showToolEvents) {
    return null;
  }

  let eventData = "";
  switch (eventType) {
    case "tool-call":
      eventData = `\n[Tool Call: ${part.toolName}]\n`;
      break;
    case "tool-call-streaming-start":
      eventData = `\n[Tool Execution Started]\n`;
      break;
    case "tool-result":
      eventData = `\n[Tool Result: ${JSON.stringify(part.result).substring(0, 200)}...]\n`;
      break;
    default:
      return null;
  }

  return formatStreamingData(eventData, streamId);
}
