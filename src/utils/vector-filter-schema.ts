import { z } from "zod";

// 基础操作符
const BasicOperator = z.union([z.literal("$eq"), z.literal("$ne")]);

// 数值操作符
const NumericOperator = z.union([
  z.literal("$gt"),
  z.literal("$gte"),
  z.literal("$lt"),
  z.literal("$lte"),
]);

// 逻辑操作符
const LogicalOperator = z.union([
  z.literal("$and"),
  z.literal("$not"),
  z.literal("$nor"),
  z.literal("$or"),
]);

// 数组操作符
const ArrayOperator = z.union([
  z.literal("$all"),
  z.literal("$in"),
  z.literal("$nin"),
  z.literal("$elemMatch"),
]);

// 元素操作符
const ElementOperator = z.literal("$exists");

// 正则表达式操作符
const RegexOperator = z.union([z.literal("$regex"), z.literal("$options")]);

// 查询操作符集合
const QueryOperator = z.union([
  BasicOperator,
  NumericOperator,
  LogicalOperator,
  ArrayOperator,
  ElementOperator,
  RegexOperator,
]);

// 递归定义VectorFilterSchema
const VectorFilterSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    z.record(z.any()), // 普通对象
    z.null(), // 允许null
    z.undefined(), // 允许undefined
  ])
);

// 操作符条件
const OperatorCondition = z.record(QueryOperator, z.any());

// 字段条件
const FieldCondition = z.union([
  OperatorCondition,
  z.any(), // 或任何其他类型
]);

// 完整的过滤器模式
const FilterSchema = z.union([
  z.record(z.string(), z.union([FieldCondition, VectorFilterSchema])),
  z.null(),
  z.undefined(),
]);

// 最终的验证模式
const VectorQuerySchema = z
  .object({
    indexName: z.string(),
    query: z.string(),
    filter: FilterSchema,
  })
  .optional();

export default VectorQuerySchema;
