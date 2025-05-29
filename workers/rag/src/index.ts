import { openai } from "@ai-sdk/openai";
import { embed } from "ai";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import "zod-openapi/extend";
import { createDocument } from "zod-openapi";
import { PineconeVector } from "@mastra/pinecone";
import type { Env } from "../../shared/types";

const app = new Hono<{ Bindings: Env }>();

// CORS 中间件
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "x-api-key"],
  maxAge: 86400,
}));

// Pinecone RAG 端点
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
        return c.text("Invalid request body!", 400);
      }
    }
  ),
  async (c) => {
    const data = c.req.valid("json");
    const { query, modelId, pineconeApiKey, indexName, topK } = data;
    
    try {
      // 生成查询向量
      const { embedding } = await embed({
        value: query,
        model: openai.embedding(modelId),
      });
      
      // 初始化 Pinecone 存储
      const store = new PineconeVector({
        apiKey: pineconeApiKey,
      });
      
      // 执行向量搜索
      const results = await store.query({
        indexName: indexName,
        queryVector: embedding,
        topK: topK,
      });
      
      return c.json({
        success: true,
        data: results,
        query: query,
        topK: topK
      });
    } catch (error) {
      console.error("Pinecone RAG error:", error);
      return c.json({
        success: false,
        error: {
          message: "RAG query failed",
          type: "rag_error",
          details: error instanceof Error ? error.message : String(error)
        }
      }, 500);
    }
  }
);

// API 文档端点
app.get("/rag/doc", async (c) => {
  const document = createDocument({
    openapi: "3.1.0",
    info: {
      title: "RAG API",
      version: "1.0.0",
      description: "Retrieval Augmented Generation API using Pinecone"
    },
    paths: {
      "/v1/rag/pinecone": {
        post: {
          summary: "Perform RAG query using Pinecone",
          requestBody: {
            content: {
              "application/json": {
                schema: z.object({
                  query: z.string().openapi({ description: "Query text for semantic search" }),
                  modelId: z
                    .string()
                    .default("text-embedding-3-small")
                    .openapi({ description: "OpenAI embedding model ID" }),
                  pineconeApiKey: z
                    .string()
                    .openapi({ description: "Pinecone API key" }),
                  indexName: z.string().openapi({ description: "Pinecone index name" }),
                  topK: z
                    .number()
                    .default(10)
                    .openapi({ description: "Number of top results to return" }),
                }),
              },
            },
          },
          responses: {
            "200": {
              description: "Successful RAG query",
              content: {
                "application/json": {
                  schema: z.object({
                    success: z.boolean(),
                    data: z.array(
                      z.object({
                        text: z.string(),
                        score: z.number(),
                        metadata: z.object({
                          source: z.string(),
                        }),
                      })
                    ),
                    query: z.string(),
                    topK: z.number(),
                  }),
                },
              },
            },
            "400": {
              description: "Invalid request",
            },
            "500": {
              description: "Server error",
            },
          },
        },
      },
    },
  });
  
  return c.json(document);
});

// 健康检查
app.get("/health", (c) => {
  return c.json({ 
    service: "rag-worker",
    status: "ok", 
    timestamp: new Date().toISOString() 
  });
});

// 默认路由
app.get("/", (c) => {
  return c.json({
    service: "RAG Worker",
    version: "1.0.0",
    endpoints: {
      pinecone: "/v1/rag/pinecone",
      docs: "/rag/doc",
      health: "/health"
    }
  });
});

export default {
  fetch: app.fetch.bind(app),
}; 