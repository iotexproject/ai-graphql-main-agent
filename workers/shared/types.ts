// 共享的类型定义
export interface Env {
  OPENROUTER_API_KEY: string;
  OPENAI_API_KEY: string;
  MODEL_NAME?: string;
  DATABASE_URL?: string;
  CHAT_CACHE?: KVNamespace;
  POLAR_ACCESS_TOKEN?: string;
  GATEWAY_PROJECT_ID: string;
  
  // Durable Object Namespaces
  Chat?: DurableObjectNamespace;
  APIUSAGE?: DurableObjectNamespace;
  USERSESSION?: DurableObjectNamespace;
  MCP_OBJECT?: DurableObjectNamespace;
  
  // Service Bindings (用于 Worker 间通信)
  CHAT_WORKER?: Fetcher;
  MCP_WORKER?: Fetcher;
  RAG_WORKER?: Fetcher;
  AUTH_WORKER?: Fetcher;
}

export interface RemoteSchema {
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

export interface ChatResponse {
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

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  code?: number;
} 