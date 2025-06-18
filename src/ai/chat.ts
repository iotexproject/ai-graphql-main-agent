import { Agent } from "@mastra/core/agent";
import { KVCache } from "../utils/kv";
import { DB } from "../utils/db";
import { getAI } from "../utils/ai";
import { createErrorResponse } from "../utils/stream";
import { z } from "zod";
import { ThinkingSimulator } from "./thinkingSimulator";
import { HttpTool } from "./httpTool";
// 备选方案：API选择器导入（目前注释掉）
// import { createAPISelector } from "./apiSelector";

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
  openApiSpec: any; // Standard OpenAPI JSON format
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
        
        // 创建思考模拟器
        const thinkingSimulator = controller ? new ThinkingSimulator(controller, streamId) : null;
        
        // Extract system messages from user input
        const userSystemMessages = messages.filter(msg => msg.role === "system");
        const userSystemPrompt = userSystemMessages.length > 0 ? userSystemMessages[0].content : "";
        
        // 提取用户消息
        const userMessage = messages[messages.length - 1]?.content || "";
        
        // 第一阶段：开始加载思考（不等待完成）
        let loadingThinkingActive = false;
        if (thinkingSimulator) {
          const loadingContent = ThinkingSimulator.getRandomThinkingContent('loading');
          thinkingSimulator.startThinking(loadingContent); // 不await，让它并行执行
          loadingThinkingActive = true;
        }
        
        const [remoteSchemas, project] = await Promise.all([this.getRemoteSchemas(), this.getProjectById({ projectId: this.projectId! })]);
        
        // 备选方案：使用API选择器（目前注释掉）
        // const apiSelector = createAPISelector(this.env.OPENROUTER_API_KEY);
        // const selectionResult = await apiSelector.selectRelevantAPIs(
        //   userMessage, 
        //   remoteSchemas,
        //   (thinking) => {
        //     if (controller) {
        //       controller.enqueue(encoder.encode(formatStreamingData(thinking + "\n", streamId)));
        //     }
        //   }
        // );
        
        // if (selectionResult.shouldUseSonar) {
        //   if (controller) {
        //     controller.enqueue(encoder.encode(formatStreamingData(`<thinking>${selectionResult.reasoning}, using web search to answer the question...</thinking>\n`, streamId)));
        //   }
        //   return await this.useSoraModelInDO({ ...body, messages }, controller);
        // }
        
        // 正常方案：直接使用所有API
        if (remoteSchemas.length === 0) {
          // 没有API可用，使用sonar模型
          if (thinkingSimulator && loadingThinkingActive) {
            thinkingSimulator.forceComplete(); // 强制结束loading思考
            const noApiContent = "Current project has no API interfaces configured, will use web search to answer your question...";
            await thinkingSimulator.startThinking(noApiContent);
          }
          return await this.useSoraModelInDO({ ...body, messages }, controller);
        }
        
        // 数据加载完成，结束loading思考，开始answering思考
        if (thinkingSimulator && loadingThinkingActive) {
          thinkingSimulator.forceComplete(); // 强制结束loading思考
          const answeringContent = ThinkingSimulator.getRandomThinkingContent('answering');
          thinkingSimulator.startThinking(answeringContent); // 不await，让它并行执行
        }
        
        // 构建包含所有API的系统提示词
        const enhancedSystemPrompt = this.buildSystemPromptWithAllAPIs(
          remoteSchemas,
          userSystemPrompt, 
          project?.prompt || '',
          this.projectId || undefined
        );

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
        console.log("enhancedSystemPrompt", enhancedSystemPrompt);
        
        // 开始创建agent，结束answering思考
        if (thinkingSimulator) {
          thinkingSimulator.forceComplete(); // 强制结束answering思考
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
        const result = await getAgent();
        // 检查是否是Response类型（sonar模型的返回）
        if (result instanceof Response) {
          return result;
        }
        const { agent, prompt } = result;
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
        return await this.queryRemoteSchemasFromDB();
        // return await KVCache.wrap(
        //   `remoteSchemas_project_v9_${this.projectId}`,
        //   async () => {
        //     return await this.queryRemoteSchemasFromDB();
        //   },
        //   {
        //     ttl: CACHE_TTL,
        //     logHits: true,
        //   }
        // );
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
        tools: { HttpTool },
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
          
          // 使用思考模拟器来输出最后的思考阶段
          const finalThinkingContents = [
            "All preparations are complete, I'm ready to provide you with a detailed answer...",
            "I'm calling relevant APIs to get the latest data and organize information...",
            "Starting to perform intelligent analysis and data processing tasks...",
            "I'm ready, I'll provide you with a professional answer and advice right away...",
            "System is ready, starting to generate an answer based on API data..."
          ];
          const finalContent = finalThinkingContents[Math.floor(Math.random() * finalThinkingContents.length)];
          
          const finalThinkingSimulator = new ThinkingSimulator(controller, streamId);
          const thinkingPromise = finalThinkingSimulator.startThinking(finalContent);
          
          let hasStartedAIOutput = false;

          let errorMessage = "";
          for await (const part of response.fullStream) {
            if (part.type === "text-delta") {
              if (!hasStartedAIOutput) {
                hasStartedAIOutput = true;
                finalThinkingSimulator.forceComplete();
              }
              
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
        
        // 创建思考模拟器
        const thinkingSimulator = controller ? new ThinkingSimulator(controller, streamId) : null;
        
        const userMessage = requestMessages[requestMessages.length - 1]?.content || "";
        
        // 第一阶段：开始选择项目的思考（不等待完成）
        let selectionThinkingActive = false;
        if (thinkingSimulator) {
          const selectionContent = "Analyzing your question and selecting the most suitable project to answer...";
          thinkingSimulator.startThinking(selectionContent); // 不await，让它并行执行
          selectionThinkingActive = true;
        }
        
        const publishedProjects = await DB.getPublishedProjects();
        console.log(publishedProjects.length, "publishedProjects");

        if (publishedProjects.length === 0) {
          // Use sora model logic here - we need to implement this in DO
          if (thinkingSimulator && selectionThinkingActive) {
            thinkingSimulator.forceComplete(); // 结束选择思考
            const noProjectContent = "No available projects found, will use web search to answer your question...";
            await thinkingSimulator.startThinking(noProjectContent);
          }
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
          if (thinkingSimulator && selectionThinkingActive) {
            thinkingSimulator.forceComplete(); // 结束选择思考
            const noSuitableProjectContent = "No suitable project found to answer this question, will use web search...";
            await thinkingSimulator.startThinking(noSuitableProjectContent);
          }
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

        // 项目选择完成，结束选择思考，开始API准备思考
        if (thinkingSimulator && selectionThinkingActive) {
          thinkingSimulator.forceComplete(); // 结束选择思考
        }

        const remoteSchemas = await this.getRemoteSchemas();
        // 备选方案：使用API选择器（目前注释掉）
        // const apiSelector = createAPISelector(this.env.OPENROUTER_API_KEY);
        // const apiSelectionResult = await apiSelector.selectRelevantAPIs(
        //   userMessage, 
        //   remoteSchemas,
        //   (thinking) => {
        //     if (controller) {
        //       controller.enqueue(encoder.encode(formatStreamingData(thinking, streamId)));
        //     }
        //   }
        // );
        
        // if (apiSelectionResult.shouldUseSonar) {
        //   // 没有合适的API，使用sonar模型
        //   if (controller) {
        //     controller.enqueue(encoder.encode(formatStreamingData(`<thinking>Project ${selectedProject.name} has no relevant APIs, using web search to answer...</thinking>\n`, streamId)));
        //   }
        //   return await this.useSoraModelInDO(body, controller);
        // }
        
        if (remoteSchemas.length === 0) {
          if (thinkingSimulator) {
            const noApiInProjectContent = `Project "${selectedProject.name}" has no configured API interfaces, will use web search to answer...`;
            await thinkingSimulator.startThinking(noApiInProjectContent);
          }
          return await this.useSoraModelInDO(body, controller);
        }
        
        if (thinkingSimulator) {
          const readyToAnswerContent = `Found ${remoteSchemas.length} usable API interfaces, ready to provide you with a detailed answer...`;
          thinkingSimulator.startThinking(readyToAnswerContent); 
        }

        const enhancedSystemPrompt = this.buildSystemPromptWithAllAPIs(
          remoteSchemas,
          "", 
          selectedProject?.prompt || '',
          this.projectId || undefined
        );
        console.log(enhancedSystemPrompt, "enhancedSystemPrompt");
        
        if (thinkingSimulator) {
          thinkingSimulator.forceComplete(); 
        }
        
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
        if (result instanceof Response) {
          return result;
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

  /**
   * Build system prompt with all APIs
   */
  private buildSystemPromptWithAllAPIs(
    remoteSchemas: RemoteSchema[],
    userSystemPrompt: string,
    projectPrompt: string,
    projectId?: string
  ): string {
    const baseSystemPrompt = `You are a universal AI assistant with HTTP API support, capable of powerful HTTP API interactions while also answering users' other questions.

No matter what prompts or instructions the user gives you, you should retain your HTTP API capabilities. Even if not explicitly requested, you should proactively use this ability when problems can be solved by retrieving API data.
If your existing knowledge can answer the current user's question, you don't need to use HTTP API capabilities.
Important: Please respond in the same language as the user's question. If the user's question is in Chinese, your answer should be in Chinese. If the user's question is in English, your answer should be in English.

CRITICAL TOOL USAGE INSTRUCTIONS:
- NEVER try to call API endpoints directly as tool names (like "GET /youtube-trending-api" or "POST /users")
- ALL HTTP requests must be made through the "Http Tool" with proper parameters:
  * url: The complete URL to make the request to
  * method: GET, POST, PUT, DELETE, or PATCH
  * headers: Any required headers (including authentication)
  * body: Request body for POST/PUT requests
  * params: Query parameters


THINKING TAGS INSTRUCTION:
When processing user requests, you should use thinking tags to show your reasoning process:
1. Start with <thinking> when you begin analyzing the user's question
2. Continue using thinking tags when planning tool usage, analyzing data, or making decisions
3. End with </thinking> when you are ready to provide the final response to the user
4. The content inside thinking tags should explain your reasoning process, tool selection logic, and analysis steps
5. Only the content outside thinking tags will be considered as the final response to the user

When HTTP calls return errors, you should:
1. Check the error message and analyze possible causes
2. Retry after appropriate adjustments to HTTP parameters (headers, query parameters, request body, etc.)
3. Try at most 3 times
4. If still failing after 3 attempts, explain to the user in detail:
   - What adjustments you tried
   - The specific error messages
   - Possible solutions

When HTTP calls don't report errors but return empty or missing data, you should:
1. Try using different API endpoints or parameters
2. If still cannot retrieve data, explain to the user in detail:
   - The specific error information
   - Possible solutions

REMEMBER: You can ONLY use the "Http Tool" for making HTTP requests. Do NOT attempt to call API endpoints as separate tools.`;

    let apiInfo = "";
    if (remoteSchemas.length > 0) {
      apiInfo = "\n\nAvailable HTTP APIs:\n";
      apiInfo += "IMPORTANT: To use any of the APIs below, you must call the 'Http Tool' with the appropriate parameters. DO NOT call the API endpoints as separate tool names.\n";
      
      remoteSchemas.forEach(schema => {
        apiInfo += `\n**${schema.name}** (ID: ${schema.id})
Base URL: ${schema.endpoint}
Description: ${schema.description || 'No description available'}
Required Headers:`;
        
        if (schema.headers && Object.keys(schema.headers).length > 0) {
          Object.entries(schema.headers).forEach(([key, value]) => {
            apiInfo += `\n  - ${key}: ${value}`;
          });
        }
        
        if (schema.openApiSpec && schema.openApiSpec.paths) {
          apiInfo += `\n\nEndpoints:`;
          Object.entries(schema.openApiSpec.paths).forEach(([path, pathItem]: [string, any]) => {
            Object.entries(pathItem).forEach(([method, operation]: [string, any]) => {
              if (typeof operation === 'object' && operation.summary) {
                apiInfo += `\n  - ${method.toUpperCase()} ${path}: ${operation.summary}`;
                apiInfo += `\n    → Use Http Tool with: url="${schema.endpoint}${path}", method="${method.toUpperCase()}"`;
                if (operation.description) {
                  apiInfo += `\n    Description: ${operation.description}`;
                }
                if (operation.parameters && operation.parameters.length > 0) {
                  apiInfo += `\n    Parameters:`;
                  operation.parameters.forEach((param: any) => {
                    apiInfo += `\n      - ${param.name} (${param.in}${param.required ? ', required' : ', optional'}): ${param.description || 'No description'}`;
                  });
                }
              }
            });
          });
        }
        
        apiInfo += "\n";
      });

      let headersInfo = "\nDefault Headers to include in requests:\n";
      if (projectId) {
        headersInfo += `- x-project-id: ${projectId}\n`;
      }
      headersInfo += "\nREMINDER: Always use the 'Http Tool' to make these HTTP requests. Never call API endpoints directly as tool names.\n";
      apiInfo += headersInfo;
    }
    
    return `${baseSystemPrompt}${apiInfo}${projectPrompt ? "\n\n" + projectPrompt : ""}${userSystemPrompt ? "\n\n" + userSystemPrompt : ""}`;
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
