import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getIntrospectionQuery } from "graphql";
import { KVCache } from "./utils/kv";
import { DB } from "./utils/db";

// Schema related type definitions
interface SchemaField {
  name: string;
  description: string;
  type: string;
  isEnabled?: boolean;
}

interface SchemaTypeInfo {
  name: string;
  kind: string;
  description?: string;
  fields?: Array<{
    name: string;
    description?: string;
    type: string;
  }>;
  enumValues?: Array<{
    name: string;
    description?: string;
  }>;
  inputFields?: Array<{
    name: string;
    description?: string;
    type: string;
    isRequired: boolean;
  }>;
}

// GraphQL introspection response type
interface GraphQLIntrospectionResponse {
  data?: {
    __schema?: any;
  };
  errors?: Array<{
    message: string;
  }>;
}

// 缓存TTL常量（秒）
const CACHE_TTL = 3600; // 1小时

export const SchemaDetailsTool = createTool({
  id: "schema-details",
  description: "Fetch GraphQL schema details for a specific marketplace",
  inputSchema: z.object({
    marketPlaceId: z.string().describe("The marketplace ID to fetch schema details for"),
    queryFields: z.array(z.string()).describe("List of query field names to get details for"),
  }),
  execute: async ({ context }) => {
    console.log('SchemaDetailsTool execute', context);
    try {
      // 从context获取参数
      const { marketPlaceId, queryFields } = context;
      
      // 缓存键，基于marketplaceId
      const cacheKey = `schema_marketplace_${marketPlaceId}_${queryFields.join(',')}`;
      
      // 使用KVCache.wrap获取schema数据，如果缓存不存在或过期，会执行回调函数
      const schemaData = await KVCache.wrap(
        cacheKey,
        async () => {
          console.log(`Fetching schema for marketplace ID: ${marketPlaceId}`);
          
          // 从数据库获取marketplace - 无需传递连接字符串，使用全局初始化的
          const dbResult = await DB.getMarketplaceById(marketPlaceId);
          if (!dbResult) {
            throw new Error(`Marketplace with ID ${marketPlaceId} not found`);
          }
          
          // 从marketplace中获取schema
          if (!dbResult.schemaData || !dbResult.schemaData.rawSchema) {
            throw new Error(`No schema data found for marketplace ${dbResult.name}`);
          }
          
          // 返回marketplace中的schemaData
          return dbResult.schemaData.rawSchema;
        },
        {
          ttl: CACHE_TTL,
          logHits: true
        }
      );
      
      if (!schemaData || !schemaData.types) {
        throw new Error('Invalid schema data structure');
      }
      
      // 提取查询字段的schema信息
      const result = extractSchemaForQueries(schemaData, queryFields);
      
      return {
        success: true,
        data: {
          marketPlaceId,
          ...result
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

/**
 * Extract schema information for specific query fields
 */
function extractSchemaForQueries(schema: any, queryFieldNames: string[]) {
  // Get the Query type name
  const queryTypeName = schema.queryType?.name || 'Query';
  
  // Find the Query type
  const queryType = schema.types.find((type: any) => type.name === queryTypeName);
  
  if (!queryType || !queryType.fields) {
    return {
      queries: [],
      queryTypes: {}
    };
  }
  
  // Filter only the requested query fields
  const queryFields = queryType.fields.filter((field: any) => 
    queryFieldNames.includes(field.name)
  );
  
  // Extract basic field information
  const queries = queryFields.map((field: any) => ({
    name: field.name,
    description: field.description || '',
    type: getFullTypeName(field.type),
    isEnabled: true
  }));
  
  // Extract type information with cycle detection
  const queryTypes: Record<string, any> = {};
  const visitedTypes = new Set<string>();
  
  for (const field of queryFields) {
    // Extract argument types
    const args: any[] = [];
    if (field.args && field.args.length > 0) {
      for (const arg of field.args) {
        args.push({
          name: arg.name,
          description: arg.description,
          type: getFullTypeName(arg.type),
          isRequired: isNonNullType(arg.type)
        });
        
        // Extract input type details if complex
        extractTypeDetails(schema, arg.type, queryTypes, visitedTypes, 0);
      }
    }
    
    // Extract return type details
    extractTypeDetails(schema, field.type, queryTypes, visitedTypes, 0);
    
    // Add field with its arguments
    queryTypes[`${queryTypeName}.${field.name}`] = {
      name: field.name,
      description: field.description,
      returnType: getFullTypeName(field.type),
      args: args
    };
  }
  
  return {
    queries,
    queryTypes
  };
}

/**
 * Get a human-readable full type name from a GraphQL type reference
 */
function getFullTypeName(type: any): string {
  if (type.kind === 'NON_NULL') {
    return `${getFullTypeName(type.ofType)}!`;
  }
  if (type.kind === 'LIST') {
    return `[${getFullTypeName(type.ofType)}]`;
  }
  return type.name;
}

/**
 * Check if a type is non-null (required)
 */
function isNonNullType(type: any): boolean {
  return type.kind === 'NON_NULL';
}

/**
 * Recursively extract type details with cycle detection and max depth
 */
function extractTypeDetails(
  schema: any, 
  typeRef: any, 
  result: Record<string, any>, 
  visitedTypes: Set<string>,
  depth: number,
  maxDepth: number = 5
): void {
  // Handle null case
  if (!typeRef) return;
  
  // Handle wrapper types (NON_NULL, LIST)
  if (typeRef.kind === 'NON_NULL' || typeRef.kind === 'LIST') {
    extractTypeDetails(schema, typeRef.ofType, result, visitedTypes, depth, maxDepth);
    return;
  }
  
  // Get the actual type name
  const typeName = typeRef.name;
  
  // Skip scalar and introspection types
  if (!typeName || 
      ['String', 'Int', 'Float', 'Boolean', 'ID'].includes(typeName) || 
      typeName.startsWith('__')) {
    return;
  }
  
  // Check for visited types to prevent cycles
  if (visitedTypes.has(typeName)) {
    return;
  }
  
  // Check max depth to prevent deep traversal
  if (depth > maxDepth) {
    return;
  }
  
  // Mark as visited
  visitedTypes.add(typeName);
  
  // Find the full type definition
  const fullType = schema.types.find((t: any) => t.name === typeName);
  if (!fullType) return;
  
  // Extract type information based on kind
  const extractedType: any = {
    name: fullType.name,
    kind: fullType.kind,
    description: fullType.description
  };
  
  // Handle different kinds of types
  switch (fullType.kind) {
    case 'OBJECT':
    case 'INTERFACE':
    case 'UNION':
      if (fullType.fields) {
        extractedType.fields = fullType.fields.map((field: any) => ({
          name: field.name,
          description: field.description,
          type: getFullTypeName(field.type)
        }));
        
        // Extract field types (up to a depth)
        if (depth < maxDepth) {
          for (const field of fullType.fields) {
            extractTypeDetails(schema, field.type, result, visitedTypes, depth + 1, maxDepth);
          }
        }
      }
      break;
      
    case 'ENUM':
      extractedType.enumValues = fullType.enumValues?.map((val: any) => ({
        name: val.name,
        description: val.description
      }));
      break;
      
    case 'INPUT_OBJECT':
      if (fullType.inputFields) {
        extractedType.inputFields = fullType.inputFields.map((field: any) => ({
          name: field.name,
          description: field.description,
          type: getFullTypeName(field.type),
          isRequired: isNonNullType(field.type)
        }));
        
        // Extract input field types
        if (depth < maxDepth) {
          for (const field of fullType.inputFields) {
            extractTypeDetails(schema, field.type, result, visitedTypes, depth + 1, maxDepth);
          }
        }
      }
      break;
  }
  
  // Add to result
  result[typeName] = extractedType;
} 