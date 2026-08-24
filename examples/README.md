# `@agentkit/example-app`

A runnable app module and a browser test surface (#155). This is what makes
`node server/dist/cli.js` boot: `AGENTKIT_APP_MODULE` needs a module that default-exports
`{ authenticate, deps, engine, buildContext }`, and until this existed there was none anywhere.

## What this is not

Example code is what people copy, so the disclaimers come first.

- **Not an auth reference.** `authenticate` reads the tenant from a request header, which is not authentication —
  any caller can claim any tenant. It refuses to start without `AGENTKIT_EXAMPLE_DEV_AUTH=1` for that reason.
- **Not a deployment template.** One process per role, no TLS, no rate limiting, GraphiQL on.
- **Not a product UI.** The page is deliberately plain; anything that looks designed gets read as a design
  decision and argued about instead of used.

## Run it

```bash
cp .env.example .env      # then set AGENTKIT_MODEL_API_KEY
npm run build
npm run migrate -w @agentkit/example-app   # once — creates the schema and its tables
npm run app    -w @agentkit/example-app    # terminal 1: page + GraphQL + SSE
npm run worker -w @agentkit/example-app    # terminal 2: nothing executes without this
```

Then open <http://localhost:4000/>.

**The worker is a separate process on purpose.** The whole point of the durable runtime is that the API host and
the worker share nothing but Postgres and the queue. One process doing both would be the shape the platform
exists to avoid — and #144 recorded that this boundary had never actually been exercised.

## Configuration

Everything is in `.env` at the repository root; `.env.example` documents each variable. `.env` is gitignored and
`.env.example` is committed, and never the other way round.

| Variable | Notes |
|---|---|
| `AGENTKIT_MODEL_API_KEY` | **Required, no default.** A key for whatever `AGENTKIT_MODEL_BASE_URL` points at. |
| `AGENTKIT_MODEL_ID` | Defaults to `gpt-4o-mini`. |
| `AGENTKIT_MODEL_BASE_URL` | Unset for `api.openai.com`; set for a local server. |
| `AGENTKIT_DATABASE_URL` | Any Postgres. |
| `AGENTKIT_EXAMPLE_SCHEMA` | A **dedicated schema**, default `agentkit_example`. |
| `AGENTKIT_REDIS_URL` | Include a database number (`/9`) if the Redis is shared. |
| `AGENTKIT_SCHEMA_MODE` | `off`, so booting never migrates. Migration is a command you run on purpose. |
| `AGENTKIT_EXAMPLE_DEV_AUTH` | Must be `1`. There is no implicit way to enable header auth. |

### The model needs tool calling

An agent without tool calls is not much of an agent. Verified before choosing a default: a local 8B GGUF returned
an empty message with `tool_calls: null` for a request a hosted model answered with a correct call. If your
endpoint cannot call tools, the example fails on the first turn — which is the correct outcome, not a bug.

### It shares a database, and stays out of the way

`AGENTKIT_EXAMPLE_SCHEMA` exists so the example can run inside a database that belongs to something else. All 20
migrations land in that schema; nothing touches `public`. `npm run migrate -w @agentkit/example-app -- --down`
drops the schema and everything in it. The migrate script **asserts the `search_path` actually took effect**,
because a silently ignored connection option would put every table in `public` — which here is another project's
schema.

## What it exercises

| | |
|---|---|
| `list_notes` | The ordinary read path; a tool result becoming a `tool-result` part. |
| `publish_note` | The HITL approval gate — suspend, decide, resume, execute **exactly once**. |
| `flaky_lookup` | The retry and `error` part paths, deterministically (fails once per key, then succeeds). |
| role selector | `viewer` cannot *see* `publish_note` in the catalogue, rather than being refused after asking. |
| note `n3` | Its title is a prompt-injection payload. Watch the model not comply. |

That last one is the point of the `external`-origin context section: note titles are written by whoever created
the note, so they are exactly the content the untrusted-content envelope (#145) exists for. A unit test can show
the bytes are enclosed; only running it shows the model treating them as data.

## Things running this found

The wiring being *correct* was where the surprises were, as the issue predicted. Four of them were in the
platform, not here — see the issue for the detail:

1. **`createServer(host)` could not serve a single request.** The composed handler's callable body was the WHATWG
   `fetch`, and Node calls a listener with `(IncomingMessage, ServerResponse)`. Every request died on
   `Failed to parse URL from [object Object]`. The tests call `host.fetch(new Request(…))` — the one path that
   worked.
2. **`instanceof Request` was the wrong check.** `@whatwg-node/server` ponyfills its own `Request`, so a genuine
   request arriving through the Node adapter is not `instanceof` the global one.
3. **No message-ingestion port.** `MessageStore` is read-only; the adapter's `append` is documented as a
   test-only affordance. Every host must reach past the port to record what the user said.
4. **No assistant message is ever persisted.** The worker emits parts into the event log but takes no message
   store, so `loadHistory` — which reads messages — never sees the assistant's side. This example projects it
   from the event log with the platform's own `reduceRunEvent`.
