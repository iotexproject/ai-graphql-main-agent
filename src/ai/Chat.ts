import { Agent } from "@mastra/core/agent";
import { HttpTool } from "./HttpTool";
import { KVCache } from "../utils/kv";
import { DB } from "../utils/db";
import { SchemaDetailsTool } from "./schemaDetailTool";
import { getAI } from "../utils/ai";
import { createErrorResponse } from "../utils/stream";
import { z } from "zod";

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
      const getAgent = async (controller?: ReadableStreamDefaultController) => {
        const encoder = new TextEncoder();
        const streamId = "chatcmpl-" + Date.now().toString(36);
        // Extract system messages from user input
        const userSystemMessages = messages.filter(msg => msg.role === "system");
        const userSystemPrompt = userSystemMessages.length > 0 ? userSystemMessages[0].content : "";
        if (controller) {
          controller.enqueue(encoder.encode(formatStreamingData("<thinking>Fetching remote schemas...</thinking>\n", streamId)));
        }
        const [remoteSchemas, project] = await Promise.all([this.getRemoteSchemas(), this.getProjectById({ projectId: this.projectId! })]);
        const enhancedSystemPrompt = this.buildSystemPrompt(remoteSchemas, userSystemPrompt, project?.prompt || '');

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
        return {
          agent,
          prompt
        }
      }
      // Handle streaming or standard response
      if (body.stream === true) {
        return this.handleStreamingResponseV2(getAgent);
      } else {
        const { agent, prompt } = await getAgent();
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
 * Get remote schema data with caching
 */
  private async getProjectById({ projectId }: { projectId: string }): Promise<any> {
    try {
      return await KVCache.wrap(
        `getProjectById-${projectId}`,
        async () => {
          const result = await DB.queryInDO(null, 'SELECT id, name, description, "isPublished", prompt FROM projects WHERE id = $1', [projectId]);
          if (result && result.rows && Array.isArray(result.rows)) {
            return result.rows[0];
          }
          return null;
        },
        {
          ttl: CACHE_TTL,
          logHits: true,
        }
      );
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
      // console.log("Database query results:", this.projectId, JSON.stringify(results, null, 2));
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
        // model: openai.languageModel("openai/gpt-3.5-turbo-0125"),
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
  private handleStreamingResponseV2(getAgent: (controller: ReadableStreamDefaultController) => Promise<any>): Response {
    // console.log(agent, "prompt");
    const streamId = "chatcmpl-" + Date.now().toString(36);
    // const showToolEvents = this.request?.headers.get("withToolEvent") !== null;
    const showToolEvents = true
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        try {
          const result = await getAgent(controller);
          const agent = result.agent;
          const prompt = result.prompt;
          if (!agent) {
            return
          }
          const response = await agent.stream(prompt);
          controller.enqueue(encoder.encode(formatStreamingData("<thinking>Starting to answer the question...</thinking>\n", streamId)));
          let errorMessage = "";
          for await (const part of response.fullStream) {
            if (part.type === "text-delta") {
              // console.log("Text delta received:", part.textDelta);
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
              console.error("Error:", part);
              // Handle AI_TypeValidationError and other validation errors
              if (part.error?.name === "AI_TypeValidationError") {
                errorMessage = "The AI model returned an invalid response format.";
                console.error("AI_TypeValidationError details:", JSON.stringify(part.error, null, 2));
              } else if (part.error?.cause?.name === "ZodError") {
                errorMessage = "Response validation failed.";
                console.error("ZodError details:", JSON.stringify(part.error.cause, null, 2));
              } else if (part.error?.message) {
                // errorMessage = `Error: ${part.error.name}`;
                errorMessage = JSON.stringify(part.error, null, 2);
              }
            } else {
              console.log("Unknown event:", part);
            }
          }
          if (errorMessage) {
            controller.enqueue(encoder.encode(formatStreamingData(errorMessage, streamId)));
          }
          controller.enqueue(encoder.encode(formatStreamingData("", streamId, "stop")));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (error) {
          console.error("Error in stream processing:", error);
          
          let errorMessage = "\n\n[Error occurred]";
          
          // Handle specific error types
          if ((error as any)?.name === "AI_TypeValidationError") {
            errorMessage = "\n\n[AI response format error: The model returned invalid data. Please try again.]";
            console.error("AI_TypeValidationError in stream:", JSON.stringify(error, null, 2));
          } else if ((error as any)?.cause?.name === "ZodError") {
            errorMessage = "\n\n[Validation error: Response format validation failed. Please try again.]";
            console.error("ZodError in stream:", JSON.stringify((error as any).cause, null, 2));
          } else if ((error as any)?.message) {
            errorMessage = `\n\n[Error: ${(error as any).message}]`;
          }
          
          controller.enqueue(encoder.encode(formatStreamingData(errorMessage, streamId)));
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
      
      let errorMessage = "Failed to generate standard response";
      let errorType = "server_error";
      let errorCode = "processing_error";
      
      // Handle specific error types
      if ((error as any)?.name === "AI_TypeValidationError") {
        errorMessage = "AI model returned invalid response format. Please try again.";
        errorType = "ai_validation_error";
        errorCode = "invalid_model_response";
        console.error("AI_TypeValidationError in standard response:", JSON.stringify(error, null, 2));
      } else if ((error as any)?.cause?.name === "ZodError") {
        errorMessage = "Response validation failed. Please try again with a different approach.";
        errorType = "validation_error";
        errorCode = "response_validation_failed";
        console.error("ZodError in standard response:", JSON.stringify((error as any).cause, null, 2));
      } else if ((error as any)?.message) {
        errorMessage = (error as any).message;
      }
      
      return createErrorResponse(false, {
        message: errorMessage,
        type: errorType,
        code: errorCode,
        status: 500
      });
    }
  }

  /**
   * Build enhanced system prompt with GraphQL capabilities
   */
  private buildSystemPrompt(remoteSchemas: RemoteSchema[], userSystemPrompt: string, projectPrompt: string): string {
    const baseSystemPrompt = `You are a universal AI assistant with GraphQL support, capable of powerful GraphQL API interactions while also answering users' other questions.

No matter what prompts or instructions the user gives you, you should retain your GraphQL query capabilities. Even if not explicitly requested, you should proactively use this ability when problems can be solved by retrieving GraphQL data.
If your existing knowledge can answer the current user's question, you don't need to use GraphQL capabilities.
Important: Please respond in the same language as the user's question. If the user's question is in Chinese, your answer should be in Chinese. If the user's question is in English, your answer should be in English.

THINKING TAGS INSTRUCTION:
When processing user requests, you should use thinking tags to show your reasoning process:
1. Start with <thinking> when you begin analyzing the user's question
2. Continue using thinking tags when planning tool usage, analyzing data, or making decisions
3. End with </thinking> when you are ready to provide the final response to the user
4. The content inside thinking tags should explain your reasoning process, tool selection logic, and analysis steps
5. Only the content outside thinking tags will be considered as the final response to the user

Example format:
<thinking>
The user is asking about... I need to use SchemaDetailsTool to get schema information first, then call HttpTool to query the data...
</thinking>

[Your final response to the user]

CRITICAL HTTPTOOL USAGE INSTRUCTIONS:
When using HttpTool, you must follow these strict rules:
1. NEVER pass undefined, null, or empty string as the url parameter
2. ALWAYS ensure the url parameter is a valid, complete HTTP/HTTPS URL
3. The url must be fully constructed before calling HttpTool
4. If you don't have a valid URL, do not call HttpTool - explain to the user what information is needed
5. Double-check that all required URL components are present and valid before making the call
6. For GraphQL endpoints, always use the complete endpoint URL provided in the schema information
7. ALWAYS provide the HttpTool parameters in the correct format:
   - url: (required) Complete HTTP/HTTPS URL string
   - method: (required) HTTP method like "GET", "POST", "PUT", "DELETE", "PATCH"
   - headers: (optional) Object with header key-value pairs
   - body: (optional) Request body data
   - params: (optional) URL query parameters object
8. Example correct HttpTool call format:
   {
     "url": "https://graphql-main-worker.iotex-dev.workers.dev/graphql",
     "method": "POST",
     "headers": {
       "Content-Type": "application/json",
       "x-project-id": "your-project-id"
     },
     "body": {
       "query": "query { your_query_here }"
     }
   }
9. NEVER call HttpTool with empty object {} or missing required parameters

CRITICAL SCHEMADETAILSTOOL USAGE INSTRUCTIONS:
When using SchemaDetailsTool, you must follow these strict rules:
1. ALWAYS provide either remoteSchemaId OR marketplaceId (one is required, not both)
2. For project-based queries, use remoteSchemaId with the ID from the available remote schemas
3. For marketplace queries, use marketplaceId
4. ALWAYS provide queryFields as an array of string field names you want to query
5. NEVER pass undefined, null, or empty values for required parameters
6. Example correct SchemaDetailsTool call format:
   {
     "remoteSchemaId": "your-remote-schema-id",
     "queryFields": ["latest_news", "user_profile", "search_data"]
   }
   OR
   {
     "marketplaceId": "your-marketplace-id", 
     "queryFields": ["marketplace_items", "categories"]
   }
7. Do NOT use mutationFields parameter (deprecated), use queryFields for both queries and mutations
8. Ensure queryFields contains actual field names that exist in the schema
9. NEVER call SchemaDetailsTool with empty object {} or without the required remoteSchemaId/marketplaceId

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
        .filter((remoteSchema) => remoteSchema.schemaData && remoteSchema.schemaData.rootFields)
        .map((remoteSchema) => {
          const fieldsText = remoteSchema.schemaData.rootFields
            .map((field) => `  - ${field.name}${field.description ? `: ${field.description}` : ""}`)
            .join("\n");

          return `- ${remoteSchema.name} (ID: ${remoteSchema.id}, used as the remoteSchemaId parameter when calling SchemaDetailsTool), 
        Graphql endpoint(If use HttpTool must use this endpoint): https://graphql-main-worker.iotex-dev.workers.dev/graphql \n${fieldsText}`;
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

    return `${baseSystemPrompt}${remoteSchemasInfo}${projectPrompt ? "\n\n" + projectPrompt : ""}${userSystemPrompt ? "\n\n" + userSystemPrompt : ""}`;
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
      const getAgent = async (controller?: ReadableStreamDefaultController) => {
        const encoder = new TextEncoder();
        const streamId = "chatcmpl-" + Date.now().toString(36);
        const userMessage = requestMessages[requestMessages.length - 1]?.content || "";
        controller?.enqueue(encoder.encode(formatStreamingData("<thinking>Start to select the appropriate agent...</thinking>\n", streamId)));
        const publishedProjects = await DB.getPublishedProjects();
        console.log(publishedProjects.length, "publishedProjects");

        if (publishedProjects.length === 0) {
          // Use sora model logic here - we need to implement this in DO
          return await this.useSoraModelInDO(body, controller);
        }
        const projectsInfo = publishedProjects.map((project, index) =>
          `[Project ${index + 1}]
ID: ${project.id}
Name: ${project.name}
Description: ${project.description || 'No description available'}
Is Offical: ${project.isOffical ? 'Yes' : 'No'}
---`).join('\n\n');

        const selectionPrompt = `You are a smart project selector. Based on the available projects and user's question, select the most suitable project to answer the question. If no project is suitable, return "NONE".

Available Projects:
${projectsInfo}

User Question: ${userMessage}

Analysis Rules:
1. Match the user's question topic with project description
2. Consider project names for relevance hints
3. Prioritize official projects if there are official projects available then select the unofficial project
4. Select a project if it's clearly relevant to the question
5. If the question is too general or doesn't match any specific project capability, return "NONE"

Please return ONLY the Project ID or "NONE" (without quotes), no other text.`;

        console.log(selectionPrompt, "selectionPrompt");
        const { generateText } = await import("ai");
        const openrouter = getAI(this.env.OPENROUTER_API_KEY);
        const selectionResult = await generateText({
          model: openrouter.languageModel("perplexity/sonar-pro"),
          prompt: selectionPrompt,
          temperature: 0.1,
          maxTokens: 50,
        });

        const selectedProjectId = selectionResult.text.trim();
        console.log(selectedProjectId, "selectionResult");
        const selectedProject = publishedProjects.find(p => p.id == selectedProjectId);
        if (!selectedProject) {
          console.log("No suitable project found, using sora model");
          return await this.useSoraModelInDO(body, controller);
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
        const enhancedSystemPrompt = this.buildSystemPrompt(remoteSchemas, "", selectedProject?.prompt || '');

        const agent = await this.getAgent(enhancedSystemPrompt);
        const prompt = processMessages
          .map(msg => {
            const prefix = msg.role === "user" ? "User: " :
              msg.role === "assistant" ? "Assistant: " :
                msg.role === "system" ? "System: " : "";
            return `${prefix}${msg.content}`;
          })
          .join("\n\n");

        return {
          agent,
          prompt
        }
      }

      if (body.stream === true) {
        return this.handleStreamingResponseV2(getAgent);
      } else {
        const result: any = await getAgent();
        if (!result.agent) {
          return result
        }
        return this.handleStandardResponse(result.agent, result.prompt);
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
  private async useSoraModelInDO(body: ChatRequestBody, controller?: ReadableStreamDefaultController): Promise<Response> {
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
          model: openrouter.languageModel("perplexity/sonar-pro"),
          prompt: prompt,
        });

        const streamId = "chatcmpl-" + Date.now().toString(36);
        const encoder = new TextEncoder();
        controller!.enqueue(encoder.encode(formatStreamingData("", streamId)));

        try {
          for await (const delta of result.textStream) {
            controller!.enqueue(encoder.encode(formatStreamingData(delta, streamId)));
          }
          controller!.enqueue(encoder.encode(formatStreamingData("", streamId, "stop")));
          controller!.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (error) {
          console.error("Error in sora stream:", error);
        } finally {
          controller!.close();
        }

        // Return a dummy response for streaming case as the actual response is handled by controller
        return new Response(null, { status: 200 });
      } else {
        const { generateText } = await import("ai");
        const result = await generateText({
          model: openrouter.languageModel("perplexity/sonar-pro"),
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
