import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { handleSchemaDetails } from "./utils/tool-handlers";

// 创建Schema详情工具
export const SchemaDetailsTool = createTool({
  id: "schema-details",
  description: "Fetch GraphQL schema details for a specific schema",
  inputSchema: z.object({
    remoteSchemaId: z.string().optional().describe("The remoteSchema ID to fetch schema details for"),
    marketplaceId: z.string().optional().describe("The marketplace ID to fetch schema details for"),
    queryFields: z.array(z.string()).optional().describe("List of field names to get details for (can be query or mutation fields)"),
    mutationFields: z.array(z.string()).optional().describe("List of mutation field names to get details for (deprecated, use queryFields for both)"),
  }).refine(data => data.remoteSchemaId || data.marketplaceId, {
    message: "Either remoteSchemaId or marketplaceId must be provided",
    path: ["remoteSchemaId"]
  }),
  execute: async ({ context }) => {
    console.log('SchemaDetailsTool execute', context);
    try {
      const { remoteSchemaId, marketplaceId, queryFields = [], mutationFields = [] } = context;
      
      // 合并查询字段
      const allFields = [...new Set([...queryFields, ...mutationFields])];
      
      // 使用通用的Schema详情处理函数
      const result = await handleSchemaDetails({
        remoteSchemaId,
        marketplaceId,
        queryFields: allFields
      });
      
      if (!result.success) {
        return {
          success: false,
          error: result.error
        };
      }
      
      return {
        success: true,
        data: {
          sourceType: marketplaceId ? 'marketplace' : 'remoteSchema',
          sourceId: marketplaceId || remoteSchemaId,
          fields: result.fieldDetails
        }
      };
    } catch (error) {
      console.error('Error in SchemaDetailsTool:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}); 