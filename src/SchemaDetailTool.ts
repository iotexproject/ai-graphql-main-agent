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
// const CACHE_TTL = 3600; // 1小时
const CACHE_TTL = 10; // 10秒

export const SchemaDetailsTool = createTool({
  id: "schema-details",
  description: "Fetch GraphQL schema details for a specific remote schema",
  inputSchema: z.object({
    remoteSchemaId: z.string().describe("The remoteschema ID to fetch schema details for"),
    queryFields: z.array(z.string()).optional().describe("List of field names to get details for (can be query or mutation fields)"),
    mutationFields: z.array(z.string()).optional().describe("List of mutation field names to get details for (deprecated, use queryFields for both)"),
  }),
  execute: async ({ context }) => {
    console.log('SchemaDetailsTool execute', context);
    try {
      // 从context获取参数
      const { remoteSchemaId, queryFields = [], mutationFields = [] } = context;
      
      // 合并字段查询，使queryFields可以查询两种类型
      const allFields = [...new Set([...queryFields, ...mutationFields])];
      
      // 缓存键，基于remoteSchemaId和所有字段
      const cacheKey = `schema_remote_${remoteSchemaId}_fields_${allFields.join(',')}`;
      
      // 使用KVCache.wrap获取schema数据
      const schemaData = await KVCache.wrap(
        cacheKey,
        async () => {
          console.log(`Fetching schema for remote schema ID: ${remoteSchemaId}`);
          
          // 从数据库获取marketplace
          const dbResult = await DB.getRemoteSchemaById(remoteSchemaId);
          if (!dbResult) {
            throw new Error(`Marketplace with ID ${remoteSchemaId} not found`);
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
      
      // Debug logging for schema structure
      console.log('Schema structure:', {
        queryType: schemaData.queryType,
        mutationType: schemaData.mutationType,
        typeCount: schemaData.types.length,
        hasTypes: !!schemaData.types,
      });
      
      // 提取查询和变更字段的schema信息
      const queryResult = extractSchemaForQueries(schemaData, allFields);
      const mutationResult = extractSchemaForMutations(schemaData, allFields);
      
      // 增强结果数据 - 处理union类型
      enhanceResultsWithUnionTypes(schemaData, queryResult, mutationResult);
      
      console.log('查询结果:', {
        queryCount: queryResult.queries.length,
        queryTypeCount: Object.keys(queryResult.queryTypes).length
      });
      
      console.log('变更结果:', {
        mutations: mutationResult.mutations,
        mutationTypes: JSON.stringify(mutationResult.mutationTypes)
      });
      
      return {
        success: true,
        data: {
          remoteSchemaId,
          queries: queryResult.queries,
          queryTypes: queryResult.queryTypes,
          mutations: mutationResult.mutations,
          mutationTypes: mutationResult.mutationTypes
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
 * Extract schema information for specific mutation fields
 */
function extractSchemaForMutations(schema: any, mutationFieldNames: string[]) {
  // First try to get mutation type from standard location
  const stdMutationTypeName = schema.mutationType?.name;
  console.log('Standard mutation type name:', stdMutationTypeName);
  
  let mutationType: any = null;
  let mutationTypeName: string | null = null;
  
  // Try standard approach first
  if (stdMutationTypeName) {
    mutationTypeName = stdMutationTypeName;
    mutationType = schema.types.find((type: any) => type.name === mutationTypeName);
  }
  
  // If standard approach fails, try to find a type named "Mutation"
  if (!mutationType || !mutationType.fields) {
    console.log('Standard mutation type not found, searching for alternatives...');
    
    // Search for mutation type by name convention
    const possibleMutationTypes = schema.types.filter((type: any) => 
      type.name === 'Mutation' || 
      type.name.includes('Mutation') ||
      type.name.toLowerCase() === 'mutation' ||
      type.name.toLowerCase().includes('mutation')
    );
    
    console.log('Found potential mutation types:', possibleMutationTypes.map((t: any) => t.name));
    
    // Use the first available mutation type
    if (possibleMutationTypes.length > 0) {
      mutationType = possibleMutationTypes[0];
      mutationTypeName = mutationType.name;
      console.log('Using alternative mutation type:', mutationTypeName);
    }
  }
  
  // As a last resort, look for types with mutation-like fields
  if (!mutationType || !mutationType.fields) {
    console.log('No mutation type found by name, scanning object types for mutation fields...');
    
    // Find OBJECT types with fields whose names include requested mutation fields
    const objectTypes = schema.types.filter((type: any) => 
      type.kind === 'OBJECT' && type.fields && type.fields.length > 0
    );
    
    // Check each object type for fields matching requested mutation names
    for (const type of objectTypes) {
      const matchingFields = type.fields.filter((field: any) => 
        mutationFieldNames.some(name => field.name.includes(name))
      );
      
      if (matchingFields.length > 0) {
        console.log(`Found type ${type.name} with potential mutation fields:`, 
          matchingFields.map((f: any) => f.name));
        mutationType = type;
        mutationTypeName = type.name;
        break;
      }
    }
  }
  
  // If we still couldn't find a mutation type, return empty results
  if (!mutationType || !mutationType.fields) {
    console.log('No suitable mutation type found in schema');
    console.log('All available types:', schema.types.map((t: any) => t.name));
    return {
      mutations: [],
      mutationTypes: {}
    };
  }
  
  console.log(`Using mutation type: ${mutationTypeName}`);
  console.log('Available fields:', mutationType.fields.map((f: any) => f.name));
  console.log('Requested mutation fields:', mutationFieldNames);
  
  // Check for exact field matches first
  let mutationFields = mutationType.fields.filter((field: any) => 
    mutationFieldNames.includes(field.name)
  );
  
  // If no exact matches, try partial matches (fields that contain the requested names)
  if (mutationFields.length === 0 && mutationFieldNames.length > 0) {
    console.log('No exact field matches found, trying partial matches...');
    mutationFields = mutationType.fields.filter((field: any) => 
      mutationFieldNames.some(name => field.name.includes(name))
    );
  }
  
  console.log('Matched mutation fields:', mutationFields.map((f: any) => f.name));
  
  // Extract basic field information
  const mutations = mutationFields.map((field: any) => ({
    name: field.name,
    description: field.description || '',
    type: getFullTypeName(field.type),
    isEnabled: true
  }));
  
  // Extract type information with cycle detection
  const mutationTypes: Record<string, any> = {};
  const visitedTypes = new Set<string>();
  
  for (const field of mutationFields) {
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
        extractTypeDetails(schema, arg.type, mutationTypes, visitedTypes, 0);
      }
    }
    
    // Extract return type details
    extractTypeDetails(schema, field.type, mutationTypes, visitedTypes, 0);
    
    // Add field with its arguments
    mutationTypes[`${mutationTypeName}.${field.name}`] = {
      name: field.name,
      description: field.description,
      returnType: getFullTypeName(field.type),
      args: args
    };
  }
  
  return {
    mutations,
    mutationTypes
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
    
    case 'UNION':
      // 处理联合类型，获取所有可能的类型
      if (fullType.possibleTypes && fullType.possibleTypes.length > 0) {
        extractedType.possibleTypes = fullType.possibleTypes.map((possibleType: any) => 
          possibleType.name
        );
        
        // 提取每种可能类型的详细信息
        if (depth < maxDepth) {
          for (const possibleType of fullType.possibleTypes) {
            // 记录联合类型与其可能类型的关系
            result[`${typeName}_union_${possibleType.name}`] = {
              unionType: typeName,
              objectType: possibleType.name
            };
            
            // 提取可能类型的详细信息
            extractTypeDetails(schema, possibleType, result, visitedTypes, depth + 1, maxDepth);
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

/**
 * 增强结果数据，处理Union类型，添加可能类型及其字段信息
 */
function enhanceResultsWithUnionTypes(schema: any, queryResult: any, mutationResult: any) {
  // 获取所有返回类型
  const allReturnTypes = [
    ...queryResult.queries.map((q: any) => q.type),
    ...mutationResult.mutations.map((m: any) => m.type)
  ];
  
  // 查找UNION类型
  const unionTypes = schema.types.filter((type: any) => 
    type.kind === 'UNION' && allReturnTypes.includes(type.name)
  );
  
  console.log('Found union types:', unionTypes.map((t: any) => t.name));
  
  // 处理每个UNION类型
  for (const unionType of unionTypes) {
    const unionTypeName = unionType.name;
    
    // 在queryTypes和mutationTypes中查找并增强包含该union类型的字段
    for (const [key, value] of Object.entries(queryResult.queryTypes)) {
      if ((value as any).returnType === unionTypeName) {
        (value as any).returnTypeKind = 'UNION';
        (value as any).possibleTypes = unionType.possibleTypes?.map((pt: any) => ({
          name: pt.name,
          kind: pt.kind || 'OBJECT'
        }));
        
        // 添加可能类型的字段信息
        (value as any).possibleTypeFields = {};
        for (const pt of unionType.possibleTypes || []) {
          const possibleType = schema.types.find((t: any) => t.name === pt.name);
          if (possibleType && possibleType.fields) {
            (value as any).possibleTypeFields[pt.name] = possibleType.fields.map((f: any) => ({
              name: f.name,
              description: f.description || '',
              type: getFullTypeName(f.type)
            }));
          }
        }
      }
    }
    
    for (const [key, value] of Object.entries(mutationResult.mutationTypes)) {
      if ((value as any).returnType === unionTypeName) {
        (value as any).returnTypeKind = 'UNION';
        (value as any).possibleTypes = unionType.possibleTypes?.map((pt: any) => ({
          name: pt.name,
          kind: pt.kind || 'OBJECT'
        }));
        
        // 添加可能类型的字段信息
        (value as any).possibleTypeFields = {};
        for (const pt of unionType.possibleTypes || []) {
          const possibleType = schema.types.find((t: any) => t.name === pt.name);
          if (possibleType && possibleType.fields) {
            (value as any).possibleTypeFields[pt.name] = possibleType.fields.map((f: any) => ({
              name: f.name,
              description: f.description || '',
              type: getFullTypeName(f.type)
            }));
          }
        }
      }
    }
  }
} 