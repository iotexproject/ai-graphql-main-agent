import { getAI } from "../utils/ai";
//qwen-7b $0.04/M input tokens$0.10/M output tokens


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

// API选择结果
interface APISelectionResult {
  selectedAPIs: Array<{
    id: string;
    path: string;
    method: string;
  }>;
  shouldUseSonar: boolean;
  reasoning?: string;
}

/**
 * API选择器类 - 实现两阶段模型策略
 * 第一阶段：便宜模型分析问题并返回相关的API ID和接口路径
 * 第二阶段：根据ID查询完整API文档，提取具体接口信息
 */
export class APISelector {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * 第一阶段：使用便宜模型分析问题并返回相关的API ID和接口路径
   */
  async selectRelevantAPIs(
    userMessage: string, 
    remoteSchemas: RemoteSchema[],
    onThinking?: (thinking: string) => void
  ): Promise<APISelectionResult> {
    console.log("remoteSchemas", remoteSchemas);
    if (!remoteSchemas.length) {
      onThinking?.("<thinking>No APIs available, will use sonar search instead.</thinking>");
      return {
        selectedAPIs: [],
        shouldUseSonar: true,
        reasoning: "No APIs available"
      };
    }

    onThinking?.("<thinking>Analyzing user question and selecting relevant APIs...</thinking>");

    // 构建简化的API目录（只包含基本信息和接口列表）
    const simplifiedAPICatalog = remoteSchemas.map(schema => this.buildSimplifiedAPIInfo(schema));

    const selectionPrompt = this.buildAPISelectionPrompt(simplifiedAPICatalog, userMessage);
    console.log("selectionPrompt", selectionPrompt);
    
    try {
      const { generateText } = await import("ai");
      const openrouter = getAI(this.apiKey);
      
      onThinking?.("<thinking>Selecting relevant API endpoints...</thinking>");
      
      const result = await generateText({
        model: openrouter.languageModel("qwen/qwen-2.5-72b-instruct"),
        prompt: selectionPrompt,
        temperature: 0.1,
      });

      const parsedResult = this.parseAPISelectionResult(result.text.trim());
      
      if (parsedResult.shouldUseSonar) {
        onThinking?.("<thinking>No suitable APIs found for this question, will use web search instead.</thinking>");
      } else {
        onThinking?.("<thinking>Successfully selected relevant API endpoints.</thinking>");
      }

      return parsedResult;
      
    } catch (error) {
      console.error("Error selecting APIs:", error);
      onThinking?.("<thinking>API selection failed, falling back to web search.</thinking>");
      return {
        selectedAPIs: [],
        shouldUseSonar: true,
        reasoning: "API selection failed, fallback to sonar"
      };
    }
  }

  /**
   * 构建简化的API信息（只包含基本信息和接口列表）
   */
  private buildSimplifiedAPIInfo(schema: RemoteSchema): any {
    const spec = schema.openApiSpec;
    let apiInfo = {
      id: schema.id,
      name: schema.name,
      description: schema.description || 'No description available',
      endpoints: [] as any[]
    };

    // 提取所有端点信息（简化版）
    if (spec && spec.paths) {
      Object.entries(spec.paths).forEach(([path, pathItem]: [string, any]) => {
        Object.entries(pathItem).forEach(([method, operation]: [string, any]) => {
          if (typeof operation === 'object' && operation.summary) {
            apiInfo.endpoints.push({
              method: method.toUpperCase(),
              path: path,
              summary: operation.summary,
              description: operation.description || ''
            });
          }
        });
      });
    }

    return apiInfo;
  }

  /**
   * 构建API选择提示词
   */
  private buildAPISelectionPrompt(simplifiedAPICatalog: any[], userMessage: string): string {
    const apiDescriptions = simplifiedAPICatalog.map((api, index) => {
      let apiDesc = `[${index + 1}] **${api.name}** (ID: ${api.id})
Description: ${api.description}`;

      if (api.endpoints && api.endpoints.length > 0) {
        apiDesc += `\nEndpoints:`;
        api.endpoints.forEach((endpoint: any) => {
          apiDesc += `\n  - ${endpoint.method} ${endpoint.path}: ${endpoint.summary}`;
        });
      }

      return apiDesc;
    }).join('\n\n');

    return `You are an API endpoint selector. Based on the user's question, select the most relevant API endpoints from the available APIs.

Available APIs:
${apiDescriptions}

User Question: ${userMessage}

Task:
1. Analyze the user's question and understand their needs
2. Select the most relevant API endpoints that can help answer the question
3. Consider API dependencies (some endpoints may need to be called in sequence)
4. If no APIs are relevant, return "NONE"

Output Format:
If relevant APIs are found, return a JSON array with selected endpoints:
[
  {"id": "api_id_1", "path": "/endpoint/path", "method": "GET"},
  {"id": "api_id_2", "path": "/another/path", "method": "POST"}
]

If no relevant APIs are found, return only: NONE

Please return only the JSON array or "NONE", no other text.`;
  }

  /**
   * 解析API选择结果
   */
  private parseAPISelectionResult(resultText: string): APISelectionResult {
    const cleanResult = resultText.trim();
    
    if (cleanResult === "NONE" || cleanResult.toUpperCase().includes("NONE")) {
      return {
        selectedAPIs: [],
        shouldUseSonar: true,
        reasoning: "No relevant APIs found for this question"
      };
    }

    try {
      const selectedAPIs = JSON.parse(cleanResult);
      if (Array.isArray(selectedAPIs) && selectedAPIs.length > 0) {
        return {
          selectedAPIs,
          shouldUseSonar: false,
          reasoning: "Selected relevant API endpoints successfully"
        };
      }
    } catch (error) {
      console.error("Failed to parse API selection result:", error);
    }

    return {
      selectedAPIs: [],
      shouldUseSonar: true,
      reasoning: "Failed to parse API selection result"
    };
  }

  /**
   * 第二阶段：根据选择的API构建优化的系统提示词
   */
  buildOptimizedSystemPrompt(
    selectedAPIs: Array<{id: string, path: string, method: string}>,
    remoteSchemas: RemoteSchema[],
    userSystemPrompt: string, 
    projectPrompt: string,
    projectId?: string
  ): string {
    const baseSystemPrompt = `You are a universal AI assistant with HTTP API support, capable of powerful HTTP API interactions while also answering users' other questions.

No matter what prompts or instructions the user gives you, you should retain your HTTP API capabilities. Even if not explicitly requested, you should proactively use this ability when problems can be solved by retrieving API data.
If your existing knowledge can answer the current user's question, you don't need to use HTTP API capabilities.
Important: Please respond in the same language as the user's question. If the user's question is in Chinese, your answer should be in Chinese. If the user's question is in English, your answer should be in English.

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
   - Possible solutions`;

    let apiInfo = "";
    if (selectedAPIs.length > 0) {
      apiInfo = "\n\nAvailable HTTP APIs:\n";
      
      selectedAPIs.forEach(selectedAPI => {
        const schema = remoteSchemas.find(s => s.id === selectedAPI.id);
        if (schema) {
          const endpointInfo = this.extractEndpointInfo(schema, selectedAPI.path, selectedAPI.method);
          if (endpointInfo) {
            apiInfo += `\n**${schema.name}** (ID: ${schema.id})
Base URL: ${schema.endpoint}
Required Headers:`;
            
            if (schema.headers && Object.keys(schema.headers).length > 0) {
              Object.entries(schema.headers).forEach(([key, value]) => {
                apiInfo += `\n  - ${key}: ${value}`;
              });
            }
            
            apiInfo += `\n\nEndpoint: ${selectedAPI.method} ${selectedAPI.path}
Summary: ${endpointInfo.summary}
Description: ${endpointInfo.description}`;

            if (endpointInfo.parameters && endpointInfo.parameters.length > 0) {
              apiInfo += `\nParameters:`;
              endpointInfo.parameters.forEach((param: any) => {
                apiInfo += `\n  - ${param.name} (${param.in}${param.required ? ', required' : ', optional'}): ${param.description || 'No description'}`;
              });
            }
            
            apiInfo += "\n";
          }
        }
      });

      let headersInfo = "\nDefault Headers to include in requests:\n";
      if (projectId) {
        headersInfo += `- x-project-id: ${projectId}\n`;
      }
      apiInfo += headersInfo;
    }
    
    return `${baseSystemPrompt}${apiInfo}${projectPrompt ? "\n\n" + projectPrompt : ""}${userSystemPrompt ? "\n\n" + userSystemPrompt : ""}`;
  }

  /**
   * 从OpenAPI规范中提取具体端点信息
   */
  private extractEndpointInfo(schema: RemoteSchema, path: string, method: string): any {
    const spec = schema.openApiSpec;
    if (!spec || !spec.paths || !spec.paths[path]) {
      return null;
    }

    const pathItem = spec.paths[path];
    const operation = pathItem[method.toLowerCase()];
    
    if (!operation) {
      return null;
    }

    return {
      summary: operation.summary || '',
      description: operation.description || '',
      parameters: operation.parameters || []
    };
  }
}

/**
 * 创建API选择器实例的工厂函数
 */
export function createAPISelector(apiKey: string): APISelector {
  return new APISelector(apiKey);
} 