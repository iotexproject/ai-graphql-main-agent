import { openai } from "@ai-sdk/openai";
import { embed } from "ai";
import { type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { createDocument } from "zod-openapi";
import { PineconeVector } from "@mastra/pinecone";

// RAG request validation schema
const ragRequestSchema = z.object({
  query: z.string(),
  modelId: z.string().default("text-embedding-3-small"),
  pineconeApiKey: z.string(),
  indexName: z.string(),
  topK: z.number().default(10),
});

// RAG request validation middleware
export const ragValidator = zValidator(
  "json",
  ragRequestSchema,
  (result, c) => {
    if (!result.success) {
      return c.text("Invalid!", 400);
    }
  }
);

/**
 * Pinecone RAG interface handler function
 */
export const handlePineconeRag = async (c: Context<{ 
  Variables: { 
    json: z.infer<typeof ragRequestSchema> 
  } 
}>) => {
  //@ts-ignore
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
};

/**
 * RAG API documentation handler function
 */
export const handleRagDoc = async (c: Context) => {
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
}; 