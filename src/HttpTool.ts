import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import axios from 'axios';
import { KVCache } from "./utils/kv";
import { handleHttpRequest } from "./utils/tool-handlers";

/**
 * 生成HTTP请求的缓存键
 * 根据请求参数创建唯一的缓存键
 */
function generateCacheKey(url: string, method: string, headers: Record<string, string>, body?: any, params?: Record<string, string>): string {
  // 创建一个包含所有请求参数的对象
  const requestData = {
    url,
    method,
    headers,
    body,
    params
  };
  
  // 将对象转换为JSON字符串，然后创建缓存键
  return `http_cache_${Buffer.from(JSON.stringify(requestData)).toString('base64')}`;
}

export const HttpTool = createTool({
  id: "http-request",
  description: "Make HTTP requests to external APIs",
  inputSchema: z.object({
    url: z.string().describe("The URL to make the request to"),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET").describe("The HTTP method to use"),
    headers: z.record(z.string()).optional().describe("HTTP headers to include in the request"),
    body: z.any().optional().describe("The request body (for POST, PUT, etc.)"),
    params: z.record(z.string()).optional().describe("URL query parameters"),
  }),
  outputSchema: z.object({
    data: z.any().describe("Response data"),
  }),
  execute: async ({ context }) => {
    console.log('HttpTool execute', context);
    try {
      const { url, method, headers = {}, body, params } = context;
      
      // 使用通用HTTP请求处理函数
      const result = await handleHttpRequest({
        url,
        method,
        headers,
        body,
        params
      });
      
      if (result.error) {
        console.error('HTTP request error:', result);
        // 格式化错误响应
        if (result.status) {
          return {
            data: {
              error: `HTTP error ${result.status}: ${result.statusText}`,
              details: result.data
            }
          };
        }
        throw new Error(result.message || 'Unknown HTTP request error');
      }
      
      console.log('HTTP success:',result.data);
      return {
        data: result.data
      };
    } catch (error) {
      console.error('Error in HttpTool:', error);
      throw error;
    }
  },
}); 