import { Schema } from "effect"

export class QueryError extends Schema.TaggedError<QueryError>()("QueryError", { message: Schema.String }) {}
export class QueryOverloaded extends Schema.TaggedError<QueryOverloaded>()("QueryOverloaded", { message: Schema.String }) {}
export class QueryDeadlineExceeded extends Schema.TaggedError<QueryDeadlineExceeded>()("QueryDeadlineExceeded", { message: Schema.String }) {}
export class QueryUnavailable extends Schema.TaggedError<QueryUnavailable>()("QueryUnavailable", { message: Schema.String }) {}

export const QueryRequest = Schema.Struct({ id: Schema.Int, method: Schema.String, args: Schema.Array(Schema.Unknown) })
export const QueryReply = Schema.TaggedUnion({
	ready: {},
	result: { id: Schema.Int, value: Schema.Unknown },
	error: { id: Schema.Int, message: Schema.String },
})
export type QueryRequest = typeof QueryRequest.Type
export type QueryReply = typeof QueryReply.Type
