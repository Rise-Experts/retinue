/**
 * The deterministic functions the first-party tools delegate to — REQ-039 (#188).
 *
 * Why this is a layer of its own: boundary rule **R7** forbids the tools layer from performing I/O, because a
 * tool is "a thin, agent-facing envelope over a deterministic function" and an envelope that reached the network
 * itself would be doing the work it exists to delegate. So the network, the parsing and the arithmetic live here,
 * and `tools/library/` holds envelopes that add authorisation, approval and idempotency and then call these.
 *
 * Everything here is directly callable and separately testable, which is the other half of the point: the
 * interesting behaviour of an outbound tool — what it refuses, where it stops reading — should be provable
 * without constructing a run.
 */

export {
  DEFAULT_EGRESS_POLICY,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  createHttpClient,
  readBounded,
} from "./http.js";
export type { HttpClient, HttpClientConfig, HttpFailure, HttpOutcome, HttpRequest, HttpSuccess } from "./http.js";

export {
  DEFAULT_SEARCH_LIMIT,
  MAX_SNIPPET_CHARS,
  createFetchJson,
  createFetchPage,
  createWebSearch,
  htmlToText,
} from "./web.js";
export type { JsonResult, PageResult, SearchHit, SearchOutcome, SearchProvider } from "./web.js";

export {
  MAX_CELL_CHARS,
  MAX_CSV_ROWS,
  MAX_SQL_ROWS,
  createSqlQuery,
  createSqlSchema,
  parseCsv,
  queryJson,
} from "./data.js";
export type { CsvResult, JsonQueryResult, ReadOnlyQuery, SchemaResult, SqlResult } from "./data.js";

export { MAX_EXPRESSION_CHARS, calculate, currentTime } from "./compute.js";
export type { CalculationResult, TimeResult } from "./compute.js";
