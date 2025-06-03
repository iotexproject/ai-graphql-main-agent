import { ApiKeyManager, getApiKeyManager } from "@/utils/apikey";
import { DB } from "@/utils/db";
import { DurableObject } from "cloudflare:workers";


interface Env {
    OPENROUTER_API_KEY: string;
    OPENAI_API_KEY: string;
    MODEL_NAME?: string;
    DATABASE_URL?: string; // PostgreSQL connection string
    CHAT_CACHE?: KVNamespace; // KV namespace for caching
    POLAR_ACCESS_TOKEN: string;
    PROJECT_ID: string;
  } 
export class UserSession extends DurableObject<Env> {
    userId: string =''
    orgId: string =''
    apiKey: string =''
    isInitialized: boolean = false
    lastSyncTime: number = 0
    constructor(ctx: DurableObjectState, env: Env) {
      // Required, as we're extending the base class.
      super(ctx, env)
      // 确保DB已初始化
      DB.initialize(env.DATABASE_URL);
    }

    async init ({apiKey}: {apiKey: string}) {
        if (this.isInitialized && this.apiKey === apiKey) {
            return {orgId: this.orgId, userId: this.userId}
        }
        this.apiKey = apiKey
        return await this.ctx.blockConcurrencyWhile(async () => {
            console.log('Initializing UserSession for apiKey:', this.apiKey);
            
            try {
                // 从storage中加载所有数据，包括lastSyncTime
                const [orgId, userId, lastSyncTime] = await Promise.all([
                    this.ctx.storage.get<string>("orgId"),
                    this.ctx.storage.get<string>("userId"),
                    this.ctx.storage.get<number>("lastSyncTime") || 0
                ]);

                this.lastSyncTime = lastSyncTime as number;
                
                // 检查是否需要重新同步
                const needsSync = !orgId || !userId || (Date.now() - this.lastSyncTime > 1000 * 60 * 60);
                
                if (needsSync) {
                    console.log('Syncing from remote...');
                    await this.syncFromRemote();
                } else {
                    this.orgId = orgId as string;
                    this.userId = userId as string;
                    console.log('Using cached data:', {orgId: this.orgId, userId: this.userId});
                }
                
                if (this.orgId && this.userId) {
                    this.isInitialized = true;
                }
                
                return {userId: this.userId, orgId: this.orgId};
            } catch (error) {
                console.error('Error in UserSession init:', error);
                throw error;
            }
        });
         
    }


    async syncFromRemote() {
        try {
            console.log('syncFromRemote for apiKey:', this.apiKey);
            
            // 确保在当前DO上下文中执行数据库查询
            const userIdResult = await DB.queryInDO(
                null,
                "SELECT user_id, org_id FROM apikey_rapid WHERE key = $1", 
                [this.apiKey]
            );
            
            const userId = userIdResult?.rows[0]?.user_id;
            const orgId = userIdResult?.rows[0]?.org_id;
            if (orgId && userId) { 
                // 更新实例变量
                this.userId = userId;
                this.orgId = orgId;
                this.lastSyncTime = Date.now();
                
                // 批量写入storage
                await this.ctx.storage.transaction(async (txn) => {
                    await txn.put("orgId", orgId);
                    await txn.put("userId", userId);
                    await txn.put("lastSyncTime", this.lastSyncTime);
                });
                
                console.log('Successfully synced and stored:', {
                    userId: this.userId, 
                    orgId: this.orgId,
                    lastSyncTime: this.lastSyncTime
                });
            } else {
                console.warn('No valid user data found for apiKey:', this.apiKey);
            }
          
        } catch (error) { 
            console.error('syncFromRemote error:', error);
            // 不要重新抛出错误，让调用者决定如何处理
        }
    }

    // 添加一个清理方法
    async reset() {
        await this.ctx.storage.deleteAll();
        this.userId = '';
        this.orgId = '';
        this.apiKey = '';
        this.isInitialized = false;
        this.lastSyncTime = 0;
    }
  }