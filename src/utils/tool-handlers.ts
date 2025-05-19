import axios from 'axios';
import { KVCache } from "./kv";
import { DB } from "./db";

/**
 * 生成HTTP请求的缓存键
 */
export function generateCacheKey(url: string, method: string, headers: Record<string, string>, body?: any, params?: Record<string, string>): string {
  const requestData = {
    url,
    method,
    headers,
    body,
    params
  };
  return `http_cache_${Buffer.from(JSON.stringify(requestData)).toString('base64')}`;
}

/**
 * 获取类型的完整名称
 */
export function getFullTypeName(type: any): string {
  if (type.kind === 'NON_NULL') {
    return `${getFullTypeName(type.ofType)}!`;
  }
  if (type.kind === 'LIST') {
    return `[${getFullTypeName(type.ofType)}]`;
  }
  return type.name;
}

/**
 * 检查类型是否非空（必需）
 */
export function isNonNullType(type: any): boolean {
  return type.kind === 'NON_NULL';
}

/**
 * 通用的HTTP请求处理函数
 */
export interface HttpRequestResult {
  data?: any;
  status?: number;
  statusText?: string;
  error?: boolean;
  message?: string;
}


/**
 * 从KV缓存或数据库获取所有相关Schema
 */
export async function getSchemasByToken(token: string, env?: any) {
  try {
    // 初始化KV缓存和数据库工具
    if (env?.CHAT_CACHE) {
      KVCache.initialize(env.CHAT_CACHE);
    }
    
    if (env?.DATABASE_URL) {
      DB.initialize(env.DATABASE_URL);
    }
    
    return await KVCache.wrap(
      `remoteSchemas_project_${token}`,
      async () => {
        return await DB.getRemoteSchemasFromProjectId(token);
      },
      {
        ttl: 60 * 60, // 1小时缓存
        logHits: true
      }
    );
  } catch (error) {
    console.error('Error getting schemas by token:', error);
    return [];
  }
}

/**
 * 处理Schema详情查询
 */
export interface SchemaDetailsResult {
  success: boolean;
  error?: string;
  fieldDetails?: any[];
}

export async function handleSchemaDetails(params: {
  remoteSchemaId?: string;
  marketplaceId?: string;
  queryFields: string[];
  env?: any;
}): Promise<SchemaDetailsResult> {
  try {
    const { remoteSchemaId, marketplaceId, queryFields, env } = params;
    
    if ((!remoteSchemaId && !marketplaceId) || !queryFields || !Array.isArray(queryFields)) {
      return {
        success: false,
        error: '参数错误：需要提供remoteSchemaId或marketplaceId，以及queryFields数组'
      };
    }
    
    // 初始化KV缓存和DB
    if (env?.CHAT_CACHE) {
      KVCache.initialize(env.CHAT_CACHE);
    }
    
    if (env?.DATABASE_URL) {
      DB.initialize(env.DATABASE_URL);
    }
    
    // 确定来源类型和ID
    const sourceType = marketplaceId ? 'marketplace' : 'remoteSchema';
    const sourceId = marketplaceId || remoteSchemaId;
    
    // 构建缓存键
    const cacheKey = `schema_${sourceType}_${sourceId}_fields_${queryFields.join(',')}`;
    
    // 从缓存或数据库获取schema数据
    const schemaData = await KVCache.wrap(
      cacheKey,
      async () => {
        console.log(`Fetching schema for ${sourceType} ID: ${sourceId}`);
        
        let dbResult;
        if (sourceType === 'marketplace') {
        } else {
          dbResult = await DB.getRemoteSchemaById(sourceId as string);
        }
        
        if (!dbResult) {
          throw new Error(`${sourceType} with ID ${sourceId} not found`);
        }
        
        if (!dbResult.schemaData || !dbResult.schemaData.rawSchema) {
          throw new Error(`No schema data found for ${sourceType} ${dbResult.name}`);
        }
        
        return dbResult.schemaData.rawSchema;
      },
      {
        ttl: 60 * 10, // 10分钟缓存
        logHits: true
      }
    );
    
    if (!schemaData || !schemaData.types) {
      return {
        success: false,
        error: 'Invalid schema data structure'
      };
    }
    
    // 提取查询的schema信息
    const queryTypeName = schemaData.queryType?.name || 'Query';
    const queryType = schemaData.types.find((type: any) => type.name === queryTypeName);
    
    if (!queryType || !queryType.fields) {
      return {
        success: false,
        error: '未找到查询类型或字段'
      };
    }
    
    // 过滤请求的查询字段
    const fieldDetails = queryType.fields
      .filter((field: any) => queryFields.includes(field.name))
      .map((field: any) => {
        // 提取参数信息
        const args = field.args && field.args.length > 0
          ? field.args.map((arg: any) => ({
              name: arg.name,
              description: arg.description || '',
              type: getFullTypeName(arg.type),
              isRequired: isNonNullType(arg.type)
            }))
          : [];
        
        return {
          name: field.name,
          description: field.description || '',
          returnType: getFullTypeName(field.type),
          args
        };
      });
    
    // 如果没有找到任何字段，可能是mutation字段
    if (fieldDetails.length === 0) {
      // 尝试在Mutation类型中查找
      const mutationTypeName = schemaData.mutationType?.name || 'Mutation';
      const mutationType = schemaData.types.find((type: any) => type.name === mutationTypeName);
      
      if (mutationType && mutationType.fields) {
        const mutationFieldDetails = mutationType.fields
          .filter((field: any) => queryFields.includes(field.name))
          .map((field: any) => {
            const args = field.args && field.args.length > 0
              ? field.args.map((arg: any) => ({
                  name: arg.name,
                  description: arg.description || '',
                  type: getFullTypeName(arg.type),
                  isRequired: isNonNullType(arg.type)
                }))
              : [];
            
            return {
              name: field.name,
              description: field.description || '',
              returnType: getFullTypeName(field.type),
              args,
              isMutation: true
            };
          });
        
        if (mutationFieldDetails.length > 0) {
          return {
            success: true,
            fieldDetails: mutationFieldDetails
          };
        }
      }
    }
    
    return {
      success: true,
      fieldDetails
    };
  } catch (error) {
    console.error('Schema Details Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * 处理Schema列表查询
 */
export interface ListSchemasResult {
  success: boolean;
  error?: string;
  schemaInfo?: string;
  remoteSchemas?: any[];
  remoteSchemasInfo?: string;
  idType?: string;
}

export async function handleListSchemas(params: {
  token: string;
  marketplaceId?: string;
  forDescription?: boolean;
  env?: any;
}): Promise<ListSchemasResult> {
  try {
    const { token, marketplaceId, forDescription = false, env } = params;
    
    // 获取Schema信息
    let remoteSchemas: any[] = [];
    
    if (marketplaceId) {
    } else if (token) {
      // 使用token获取所有相关schema
      remoteSchemas = await getSchemasByToken(token, env);
    }
    
    if (remoteSchemas.length === 0) {
      return {
        success: false,
        error: "未找到Schema信息"
      };
    }
    
    // 确定ID类型
    const idType = marketplaceId ? "marketplaceId" : "remoteSchemaId";
    
    if (forDescription) {
      // 为工具描述构建Schema文本
      const remoteSchemasText = remoteSchemas.map(remoteSchema => {
        const fieldsText = remoteSchema.schemaData?.rootFields
          ?.map((field: any) => `  - ${field.name}${field.description ? `: ${field.description}` : ''}`)
          .join('\n') || '';
          
        return `- ${remoteSchema.name} (ID: ${remoteSchema.id}, used as the ${idType} parameter when calling SchemaDetailsTool), 
        Graphql endpoint: https://ai-platform-graphql-frontend.onrender.com/graphql-main-worker \n${fieldsText}`;
      }).join('\n\n');
      
      const remoteSchemasInfo = `\n\nYou can access the following GraphQL APIs and queries:\n${remoteSchemasText}\n\n
When executing any HTTP or GraphQL query, please follow this process:\n
1. First use schema_details to get GraphQL schema information\n
When use ask this tools function.you should answer the queries list to user.`;

      return {
        success: true,
        remoteSchemasInfo,
        remoteSchemas,
        idType
      };
    } else {
      // 为具体响应构建详细信息
      const schemaInfo = `# 可用的GraphQL Schemas

${remoteSchemas.map(schema => {
  const fieldsText = schema.schemaData.rootFields
    .map((field: any) => `  - ${field.name}${field.description ? `: ${field.description}` : ''}`)
    .join('\n');
    
  return `## ${schema.name} (ID: ${schema.id})
Graphql endpoint: https://ai-platform-graphql-frontend.onrender.com/graphql-main-worker 

可用字段:
${fieldsText}

使用方法:
1. 使用schema_details工具获取字段详情，需提供:
   * ${idType}: "${schema.id}"
   * queryFields: ["字段名1", "字段名2", ...]

2. 分析返回的schema信息，了解查询字段的参数类型和返回类型
3. 使用http_request工具发送GraphQL查询:
   * url: "https://ai-platform-graphql-frontend.onrender.com/graphql-main-worker"
   * method: "POST"
   * headers: { "Content-Type": "application/json", ${marketplaceId ? `"x-marketplace-id": "${marketplaceId}"` : ''} ${token ? `${marketplaceId ? ', ' : ''}"x-project-id": "${token}"` : ''} }
   * body: { "query": "your GraphQL query" }`;
}).join('\n\n')}

`;

      return {
        success: true,
        schemaInfo,
        remoteSchemas,
        idType
      };
    }
  } catch (error) {
    console.error('ListSchema error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
} 