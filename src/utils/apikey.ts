/**
 * API Key management module for handling verification and usage tracking
 */
import type { Polar } from "@polar-sh/sdk";
import { createPolarClient } from "./polar";
import { ApiUsage } from "../storage/ApiUsage";
/**
 * Structure for tracking API key usage information
 */


interface Env {
    OPENROUTER_API_KEY: string;
    OPENAI_API_KEY: string;
    MODEL_NAME?: string;
    DATABASE_URL?: string; // PostgreSQL connection string
    CHAT_CACHE?: KVNamespace; // KV namespace for caching
    POLAR_ACCESS_TOKEN: string
    APIUSAGE: DurableObjectNamespace<ApiUsage>
}

/**
 * Manages API key verification, usage tracking and caching
 */
export class ApiKeyManager {

    /**
     * In-memory cache for API key usage data
     * Stores usage information for 24 hours with max 1000 entries
     */
    kv!: KVNamespace

    env!: Env

    polarClient!: Polar

    cache = {
        get: async (key: string) => {
            const value = await this.kv.get(key)
            if (!value) return null
            try {
                return JSON.parse(value)
            } catch (e) {
                return null
            }
        },
        set: async (key: string, value: any) => {
            await this.kv.put(key, JSON.stringify(value))
        }
    }
    /**
     * Constructor accepting partial object for initialization
     */
    constructor(args: Partial<ApiKeyManager> = {}, env?: Env) {
        Object.assign(this, args)
        if (env) {
            this.env = env
        }
        if (env && env.CHAT_CACHE) {
            this.kv = env.CHAT_CACHE
        }
        if (env && env.POLAR_ACCESS_TOKEN) {
            this.polarClient = createPolarClient(env.POLAR_ACCESS_TOKEN)
        }
    }


    getKey(userId: string, projectId: string) {
        return `${userId}-${projectId}`
    }

    // getLockKey(key: string) {
    //     return `${key}-lock`
    // }

    // async acquireLock(key: string): Promise<boolean> {
    //     const lock = (await this.cache.get(this.getLockKey(key)))
    //     if (lock !== 'true') {
    //         return true
    //     }
    //     await new Promise(resolve => setTimeout(resolve, 300))
    //     return this.acquireLock(key)
    // }

    createCheckout = async ({
        userId,
        productId,
        successUrl
    }: {
        userId: string,
        productId: string,
        successUrl: string
    }) => {

        const checkout = await this.polarClient.checkouts.create({
            products: [productId],
            customerExternalId: userId,
            successUrl
        })
        return checkout
    }

    createProjectCredit = async ({
        creditName,
        meterId,
        monthCredit,
    }: {
        creditName: string,
        meterId: string,
        monthCredit: number,
    }) => {
        const creditQuery = await this.polarClient.benefits.list({
            query: creditName
        })
        if (creditQuery.result.items.length > 0) {
            return creditQuery.result.items[0]
        }
        const result = await fetch('https://sandbox-api.polar.sh/v1/benefits/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env["POLAR_ACCESS_TOKEN"]}`
            },
            body: JSON.stringify({
                type: "meter_credit",
                description: creditName,
                properties: {
                    meter_id: meterId,
                    units: monthCredit,
                    rollover: false
                },
            })
        })
        const data = await result.json()
        return data as ReturnType<typeof this.polarClient.benefits.create>
    }

    createProduct = async ({
        productName,
        monthPrice,
        meterId,
    }: {
        productName: string,
        monthPrice?: number,
        meterId: string,
    }) => {
        const productQuery = await this.polarClient.products.list({
            query: productName
        })
        if (productQuery.result.items.length > 0) {
            return productQuery.result.items[0]
        }
        const product = await this.polarClient.products.create({
            name: productName,
            prices: [monthPrice ? {
                amountType: 'fixed',
                priceAmount: monthPrice,
            } : {
                amountType: 'free',
            }, {
                amountType: 'metered_unit',
                meterId,
                unitAmount: 10,
            }],
            recurringInterval: "month",
        })
        return product
    }

    /**
     * Creates a new project product
     * @param args Object containing project ID, month price, meter ID and month credit
     * @returns Created product
     */
    createProjectProduct = async ({
        projectId,
        monthPrice,
        monthCredit,
        productTag
    }: {
        projectId: string,
        monthPrice?: number,
        monthCredit: number,
        productTag: string
    }) => {
        const productName = `${projectId}-${productTag}`
        const meter = await this.createProjectMeter({
            meterName: projectId
        })
        const [benefit, product] = await Promise.all([this.createProjectCredit({
            creditName: productName,
            meterId: meter.id,
            monthCredit,
        }), this.createProduct({
            productName,
            monthPrice,
            meterId: meter.id,
        })])
        const updatedProduct = await this.polarClient.products.updateBenefits({
            id: product.id,
            productBenefitsUpdate: {
                benefits: [benefit.id]
            }
        })
        return updatedProduct
    }

    createProjectMeter = async ({
        meterName,
    }: {
        meterName: string,
    }) => {
        const meterQuery = await this.polarClient.meters.list({
            query: meterName
        })
        if (meterQuery.result.items.length > 0) {
            return meterQuery.result.items[0]
        }
        const meter = await this.polarClient.meters.create({
            name: meterName,
            filter: {
                conjunction: 'and',
                clauses: [
                    {
                        property: 'name',
                        operator: 'eq',
                        value: meterName
                    }
                ]
            },
            aggregation: {
                func: 'sum',
                property: 'cost'
            }
        })
        return meter
    }

    /**
     * Retrieves current key state from the remote service
     * @param userId User ID to check state for
     * @returns Key state with cost, remaining balance and verification time
     */
    getKeyState = async ({ userId, projectId }: { userId: string, projectId: string }) => {
        const apiUsageMeter = await this.polarClient.meters.list({
            query: projectId
        })
        const result = await this.polarClient.customers.getStateExternal({
            externalId: userId
        })
        const activeMeter = result.activeMeters.find(m => m.meterId === apiUsageMeter.result.items[0].id)
        // Return default state if no active meter exists
        if (!activeMeter) {
            return {
                cost: 0,
                remaining: 0,
                lastVerifyTime: Date.now(),
            }
        }
        return {
            cost: 0,
            remaining: activeMeter.balance,
            lastVerifyTime: Date.now(),
        }
    }

    ingestEvent = async ({ userId, cost, projectId }: { userId: string, cost: number, projectId: string }) => {
        await this.polarClient.events.ingest({
            events: [
                {
                    name: projectId,
                    metadata: {
                        cost
                    },
                    externalCustomerId: userId,
                },
            ]
        })
    }

    verifyKeyFromRemote = async ({ userId, cost, projectId }: { userId: string, cost: number, projectId: string }) => {
        // Send usage event to remote service
        await this.ingestEvent({ userId, cost, projectId })
        // Get updated key state after reporting usage
        const keyInfo = await this.getKeyState({ userId, projectId })
        return keyInfo
    }

    /**
     * Verifies if a key can be used based on remaining balance
     * Uses caching to minimize remote service calls
     * @param key API key string
     * @param userId User ID owning the key
     * @param cost Usage cost to apply
     * @returns True if key is valid, throws error if usage exceeded
     */
    verifyKey = async ({ userId, cost, projectId }: { userId: string, cost: number, projectId: string }) => {
        const key = this.getKey(userId, projectId)
        const apiUsageId = this.env.APIUSAGE.idFromName(key)
        const apiUsage = this.env.APIUSAGE.get(apiUsageId)
        await apiUsage.init({
            userId,
            projectId
        })
        await apiUsage.consumeApiUsage({
            cost
        })
    }


  
    // /**
    //  * Verifies if a key can be used based on remaining balance
    //  * Uses caching to minimize remote service calls
    //  * @param key API key string
    //  * @param userId User ID owning the key
    //  * @param cost Usage cost to apply
    //  * @returns True if key is valid, throws error if usage exceeded
    //  */
    // verifyKey = async ({ userId, cost, projectId }: { userId: string, cost: number, projectId: string }) => {
    //     const key = this.getKey(userId, projectId)
    //     const apiUsageId = this.env.ApiUsage.idFromName(key)
    //     const apiUsage = this.env.ApiUsage.get(apiUsageId)
    //     /**
    //      * Helper function to get current key status, managing local and remote state
    //      */
    //     const getCurrentKeyStatus = async () => {
    //         /**
    //          * Handler to update local cache with remote verification results
    //          */
    //         if (keyInfo) {
    //             // Trigger remote verification if:
    //             // 1. Local cost exceeds 100
    //             // 2. Last verification was more than 5 minutes ago
    //             // 3. Local cost is about to exceed remaining balance
    //             if (keyInfo.cost > 100 || Date.now() - keyInfo.lastVerifyTime > 1000 * 60 * 5) {
    //                 if (await this.cache.get(this.getLockKey(key))) {
    //                     await this.acquireLock(key)
    //                     const keyInfo = await this.cache.get(key)
    //                     await this.cache.set(key, {
    //                         cost: keyInfo.cost + cost,
    //                         lastVerifyTime: keyInfo.lastVerifyTime,
    //                         remaining: keyInfo.remaining,
    //                         pendingVerify: null
    //                     })

    //                 } else {
    //                     await this.cache.set(this.getLockKey(key), 'true')
    //                     const remoteKeyInfo = await this.verifyKeyFromRemote({ userId, cost: keyInfo.cost + cost, projectId })
    //                     await this.cache.set(key, remoteKeyInfo)
    //                     await this.cache.set(this.getLockKey(key), 'false')
    //                 }
    //             } else {
    //                 await this.cache.set(key, {
    //                     cost: keyInfo.cost + cost,
    //                     lastVerifyTime: keyInfo.lastVerifyTime,
    //                     remaining: keyInfo.remaining,
    //                     pendingVerify: null
    //                 })
    //             }
    //         } else {
    //             if (await this.cache.get(this.getLockKey(key))) {
    //                 await this.acquireLock(key)
    //             } else {
    //                 await this.cache.set(this.getLockKey(key), 'true')
    //                 // Initialize cache for a new key with remote verification
    //                 const remoteKeyInfo = await this.verifyKeyFromRemote({ userId, cost, projectId })
    //                 this.cache.set(key, remoteKeyInfo)
    //                 await this.cache.set(this.getLockKey(key), 'false')
    //             }
    //         }
    //         const newKeyInfo = await this.cache.get(key)
    //         return newKeyInfo
    //     }
    //     // Get current key status and check if it has remaining usage
    //     const keyInfo = (await getCurrentKeyStatus())!
    //     if (keyInfo.remaining <= 0 || keyInfo.cost > keyInfo.remaining) {
    //         throw new Error('Key has no remaining usage')
    //     }
    //     return true
    // }
}

// 修改实例导出为工厂函数，在调用时传入env
export const getApiKeyManager = (env: Env) => {
  return new ApiKeyManager({}, env)
}