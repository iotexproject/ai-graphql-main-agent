import type { Pool, QueryResult } from 'pg';
import { KVCache } from "./kv";
// 全局连接池单例
let pgPool: Pool | null = null;
// 全局连接字符串
let globalConnectionString: string | undefined;

/**
 * 数据库工具类
 * 处理PostgreSQL数据库的连接和查询
 */
export class DB {
  /**
   * 初始化数据库工具类，存储全局连接字符串
   * 应在应用启动时调用此方法
   * @param connectionString 数据库连接字符串
   */
  static initialize(connectionString: string | undefined): void {
    if (connectionString) {
      console.log('Initializing DB tool with global connection string');
      globalConnectionString = connectionString;
    } else {
      console.warn('No connection string provided for DB initialization');
    }
  }

  /**
   * 获取数据库连接池（单例模式）
   * @returns 数据库连接池实例
   */
  static async getPool(): Promise<Pool | null> {
    // 检查是否有连接字符串
    if (!globalConnectionString) {
      console.warn('Database connection string not provided');
      return null;
    }

    try {
      // 如果已经存在连接池，直接返回
      if (pgPool) {
        return pgPool;
      }

      // 动态导入pg库，避免全局加载
      const { Pool } = await import('pg');

      // 创建连接池
      pgPool = new Pool({
        connectionString: globalConnectionString,
        // 可以根据需要调整连接池配置
        max: 5, // 最大连接数
        idleTimeoutMillis: 30000, // 连接最大空闲时间
        connectionTimeoutMillis: 5000, // 连接超时
      });

      // 设置错误处理，避免未捕获的错误导致应用崩溃
      pgPool.on('error', (err) => {
        console.error('Unexpected error on idle client', err);
      });

      return pgPool;
    } catch (error) {
      console.error('Error creating database pool:', error);
      return null;
    }
  }

  /**
   * 执行SQL查询
   * @param query SQL查询字符串
   * @param params 查询参数数组
   * @returns 查询结果
   */
  static async queryInDO(
    pool: Pool | null,
    query: string,
    params: any[] = []
  ): Promise<QueryResult | null> {
    try {
      let innerPool: Pool | null = pool;
      // 检查是否有连接字符串
      if (!globalConnectionString) {
        console.warn('Database connection string not provided');
        return null;
      }
      if (!innerPool) {
        const { Pool } = await import('pg');
        // 获取数据库连接池
        innerPool = new Pool({
          connectionString: globalConnectionString,
          // 可以根据需要调整连接池配置
          max: 5, // 最大连接数
          idleTimeoutMillis: 30000, // 连接最大空闲时间
          connectionTimeoutMillis: 5000, // 连接超时
        });
      }

      // 执行查询
      const result = await innerPool.query(query, params);
      return result;
    } catch (error) {
      console.error('Database query error:', error);
      return null;
    }
  }

  /**
   * 执行SQL查询
   * @param query SQL查询字符串
   * @param params 查询参数数组
   * @returns 查询结果
   */
  static async query(
    query: string,
    params: any[] = []
  ): Promise<QueryResult | null> {
    try {
      // 获取数据库连接池
      const pool = await this.getPool();
      if (!pool) {
        return null;
      }

      // 执行查询
      const result = await pool.query(query, params);
      return result;
    } catch (error) {
      console.error('Database query error:', error);
      return null;
    }
  }

  /**
   * 查询remoteSchemas表
   * @returns remoteSchemas数据
   */
  static async getRemoteSchemasFromProjectId(projectId: string): Promise<any[]> {
    console.log('getRemoteSchemasFromProjectId', projectId);
    try {
      // 执行查询获取所有marketplace记录
      const result = await this.queryInDO(
        null,
        'SELECT id, name, description, endpoint, headers, "schemaData", "createdAt" FROM "remoteSchemas" WHERE "projectId" = $1',
        [projectId]
      );

      // 检查查询结果
      if (result && result.rows && Array.isArray(result.rows)) {
        console.log(`Found ${result.rows.length} remoteSchemas`);
        return result.rows;
      }

      return [];
    } catch (error) {
      console.error('Error querying remoteSchemas from DB:', error);
      return [];
    }
  }

  /**
   * 根据ID查询单个remoteSchema
   * @param remoteSchemaId remoteSchema的ID
   * @returns 单个remoteSchema数据
   */
  static async getRemoteSchemaById(remoteSchemaId: string): Promise<any | null> {
    try {
      // 执行查询获取指定ID的marketplace记录
      const result = await this.queryInDO(
        null,
        'SELECT id, name, description, endpoint, headers, "schemaData", "createdAt" FROM "remoteSchemas" WHERE id = $1',
        [remoteSchemaId]
      );

      // 检查查询结果
      if (result && result.rows && result.rows.length > 0) {
        console.log(`Found remoteSchema with ID: ${remoteSchemaId}`);
        return result.rows[0];
      }

      console.warn(`No remoteSchema found with ID: ${remoteSchemaId}`);
      return null;
    } catch (error) {
      console.error(`Error querying remoteSchema with ID ${remoteSchemaId} from DB:`, error);
      return null;
    }
  }

  /**
   * 获取所有已发布的项目
   * @returns 已发布的项目列表
   */
  static async getPublishedProjects(): Promise<any[]> {
    try {
      // return await KVCache.wrap('getPublishedProjects-v4', async () => {
      // 执行查询获取所有已发布的项目
      const result = await  KVCache.wrap('getPublishedProjects', 
        async () => {
          return this.query(
            'SELECT id, name, description, "isPublished", "isOffical", prompt FROM projects WHERE "isPublished" = true',
            []
          )
        })

      // 检查查询结果
      if (result && result.rows && Array.isArray(result.rows)) {
        console.log(`Found ${result.rows.length} published projects`);
        return result.rows;
      }

      return [];
      // }, { ttl: 60 });
    } catch (error) {
      console.error('Error querying published projects from DB:', error);
      return [];
    }
  }

  /**
   * 关闭数据库连接池
   * 在应用关闭时调用此方法清理资源
   */
  static async closePool(): Promise<void> {
    if (pgPool) {
      try {
        await pgPool.end();
        pgPool = null;
        console.log('Database connection pool closed');
      } catch (error) {
        console.error('Error closing database pool:', error);
      }
    }
  }
} 