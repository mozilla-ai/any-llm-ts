<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/mozilla-ai/otari/refs/heads/main/docs/public/images/otari-logo-mark.png" width="20%" alt="Project logo"/>
  </picture>
</p>

<div align="center">

# otari (TypeScript)

![Node.js 18+](https://img.shields.io/badge/node-18%2B-blue.svg)
[![npm](https://img.shields.io/npm/v/@mozilla-ai/otari)](https://www.npmjs.com/package/@mozilla-ai/otari)
<a href="https://discord.gg/4gf3zXrQUc">
    <img src="https://img.shields.io/static/v1?label=Chat%20on&message=Discord&color=blue&logo=Discord&style=flat-square" alt="Discord">
</a>

**TypeScript client for [otari-gateway](https://github.com/mozilla-ai/otari).**
Communicate with any LLM provider through the gateway using a single, typed interface.

[Python SDK](https://github.com/mozilla-ai/otari) | [Documentation](https://mozilla-ai.github.io/otari/) | [Platform (Beta)](https://otari.ai/)

</div>

## Quickstart

```typescript
import { OtariClient } from "@mozilla-ai/otari";

const client = new OtariClient({
  apiBase: "http://localhost:8000",
  platformToken: "your-token-here",
});

const response = await client.completion({
  model: "openai:gpt-4o-mini",
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(response.choices[0].message.content);
```

**That's it!** Change the model string to switch between LLM providers through the gateway.

## Installation

### Requirements

- Node.js 18 or newer
- A running [otari-gateway](https://mozilla-ai.github.io/otari/gateway/overview/) instance

### Install

```bash
npm install @mozilla-ai/otari
```

### Setting Up Credentials

Set environment variables for your gateway:

```bash
export GATEWAY_API_BASE="http://localhost:8000"
export GATEWAY_PLATFORM_TOKEN="your-token-here"
# or for non-platform mode:
export GATEWAY_API_KEY="your-key-here"
```

Alternatively, pass credentials directly when creating the client (see [Usage](#usage) examples).

## otari-gateway

This TypeScript SDK is a client for [otari-gateway](https://github.com/mozilla-ai/otari), an **optional** FastAPI-based proxy server that adds enterprise-grade features on top of the core library:

- **Budget Management** - Enforce spending limits with automatic daily, weekly, or monthly resets
- **API Key Management** - Issue, revoke, and monitor virtual API keys without exposing provider credentials
- **Usage Analytics** - Track every request with full token counts, costs, and metadata
- **Multi-tenant Support** - Manage access and budgets across users and teams

The gateway sits between your applications and LLM providers, exposing an OpenAI-compatible API that works with any supported provider.

### Quick Start

```bash
docker run \
  -e GATEWAY_MASTER_KEY="your-secure-master-key" \
  -e OPENAI_API_KEY="your-api-key" \
  -p 8000:8000 \
  ghcr.io/mozilla-ai/otari/gateway:latest
```

> **Note:** You can use a specific release version instead of `latest` (e.g., `1.2.0`). See [available versions](https://github.com/orgs/mozilla-ai/packages/container/package/otari%2Fgateway).

### Managed Platform (Beta)

Prefer a hosted experience? The [otari platform](https://otari.ai/) provides a managed control plane for keys, usage tracking, and cost visibility across providers, while still building on the same `otari` interfaces.

## Usage

### Authentication Modes

The client supports two authentication modes, matching the Python SDK:

#### Platform Mode (Recommended)

Uses a Bearer token in the standard Authorization header:

```typescript
const client = new OtariClient({
  apiBase: "http://localhost:8000",
  platformToken: "tk_your_platform_token",
});
```

#### Non-Platform Mode

Sends the API key via a custom `Otari-Key` header:

```typescript
const client = new OtariClient({
  apiBase: "http://localhost:8000",
  apiKey: "your-api-key",
});
```

#### Auto-Detection from Environment Variables

When no explicit credentials are provided, the client reads from environment variables:

```typescript
// Uses GATEWAY_API_BASE, GATEWAY_PLATFORM_TOKEN, or GATEWAY_API_KEY
const client = new OtariClient();
```

### Chat Completions

```typescript
const response = await client.completion({
  model: "openai:gpt-4o-mini",
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(response.choices[0].message.content);
```

### Streaming

```typescript
const stream = await client.completion({
  model: "openai:gpt-4o-mini",
  messages: [{ role: "user", content: "Tell me a story." }],
  stream: true,
});

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) process.stdout.write(content);
}
```

### Responses API

```typescript
const response = await client.response({
  model: "openai:gpt-4o-mini",
  input: "Summarize this in one sentence.",
});

console.log(response.output_text);
```

### Embeddings

```typescript
const result = await client.embedding({
  model: "openai:text-embedding-3-small",
  input: "Hello world",
});

console.log(result.data[0].embedding);
```

### Moderation

```typescript
import { OtariClient, UnsupportedCapabilityError } from "@mozilla-ai/otari";

try {
  const result = await client.moderation({
    model: "openai:omni-moderation-latest",
    input: "I want to hurt someone",
  });
  if (result.results[0].flagged) {
    throw new Error("unsafe input");
  }
} catch (err) {
  if (err instanceof UnsupportedCapabilityError) {
    // The selected provider doesn't offer moderation (e.g. Anthropic).
    console.error(`${err.provider} does not support ${err.capability}`);
  } else {
    throw err;
  }
}
```

To preserve the upstream provider's raw response body, pass
`includeRaw: true`. Each result then carries a `provider_raw` field:

```typescript
const result = await client.moderation({
  model: "openai:omni-moderation-latest",
  input: "...",
  includeRaw: true,
});
console.log(result.results[0].provider_raw);
```

### Listing Models

```typescript
const models = await client.listModels();
for (const model of models) {
  console.log(model.id);
}
```

### Error Handling

In platform mode, HTTP errors are mapped to typed exceptions:

```typescript
import { OtariClient, AuthenticationError, RateLimitError } from "@mozilla-ai/otari";

try {
  const response = await client.completion({
    model: "openai:gpt-4o-mini",
    messages: [{ role: "user", content: "Hello!" }],
  });
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error("Invalid credentials:", error.message);
  } else if (error instanceof RateLimitError) {
    console.error("Rate limited, retry after:", error.retryAfter);
  }
}
```

| HTTP Status | Error Class | Description |
|------------|-------------|-------------|
| 400 (capability) | `UnsupportedCapabilityError` | Selected provider does not support the requested capability (e.g. moderation) |
| 401, 403 | `AuthenticationError` | Invalid or missing credentials |
| 402 | `InsufficientFundsError` | Budget or credits exhausted |
| 404 | `ModelNotFoundError` | Model not found or unavailable |
| 429 | `RateLimitError` | Rate limit exceeded (includes `retryAfter`) |
| 502 | `UpstreamProviderError` | Upstream provider unreachable |
| 504 | `GatewayTimeoutError` | Gateway timed out waiting for provider |

`UnsupportedCapabilityError` surfaces in both platform and non-platform modes; the other mappings are platform-mode only.

## Why choose `otari`?

- **Simple, unified interface** - Single client for all providers through the gateway, switch models with just a string change
- **Developer friendly** - Full TypeScript types for better IDE support and clear, actionable error messages
- **Leverages the OpenAI SDK** - Built on the official OpenAI Node.js SDK for maximum compatibility
- **Stays framework-agnostic** so it can be used across different projects and use cases
- **Battle-tested** - Powers our own production tools ([any-agent](https://github.com/mozilla-ai/any-agent))

## Development

```bash
# Install dependencies
npm install

# Run unit tests
npm run test:unit

# Run integration tests (requires a running gateway)
npm run test:integration

# Run all tests
npm test

# Type-check
npm run typecheck

# Build
npm run build
```

## Documentation

- **[Full Documentation](https://mozilla-ai.github.io/otari/)** - Complete guides and API reference
- **[Supported Providers](https://mozilla-ai.github.io/otari/providers/)** - List of all supported LLM providers
- **[Gateway Documentation](https://mozilla-ai.github.io/otari/gateway/overview/)** - Gateway setup and deployment
- **[Python SDK](https://github.com/mozilla-ai/otari)** - The full Python SDK with direct provider access
- **[otari Platform (Beta)](https://otari.ai/)** - Hosted control plane for key management, usage tracking, and cost visibility

## Contributing

We welcome contributions from developers of all skill levels! Please see the [Contributing Guide](https://github.com/mozilla-ai/otari/blob/main/CONTRIBUTING.md) or open an issue to discuss changes.

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.
