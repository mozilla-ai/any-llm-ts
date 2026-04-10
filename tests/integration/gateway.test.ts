/**
 * Integration tests against a live any-llm gateway.
 *
 * These tests require a running gateway at GATEWAY_API_BASE (default:
 * http://localhost:8000) with a valid GATEWAY_PLATFORM_TOKEN.
 *
 * The entire suite is skipped when the gateway is unreachable.
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll } from "vitest";
import { GatewayClient } from "../../src/client.js";
import { ModelNotFoundError } from "../../src/errors.js";

const API_BASE = process.env.GATEWAY_API_BASE ?? "http://localhost:8000";
const TOKEN =
  process.env.GATEWAY_PLATFORM_TOKEN ?? "tk_apwjM8KmAhOlfAUDiAWO6bmxsFuPeGqO";
const MODEL = process.env.GATEWAY_TEST_MODEL ?? "openai:gpt-4o-mini";

// Check gateway availability before loading the test suite.
let gatewayAvailable = false;
try {
  const res = await fetch(`${API_BASE}/health`);
  gatewayAvailable = res.ok;
} catch {
  gatewayAvailable = false;
}

describe.skipIf(!gatewayAvailable)("Gateway integration tests", () => {
  let client: GatewayClient;

  beforeAll(() => {
    client = new GatewayClient({
      apiBase: API_BASE,
      platformToken: TOKEN,
    });
  });

  it("completion returns a valid ChatCompletion", async () => {
    const result = await client.completion({
      model: MODEL,
      messages: [{ role: "user", content: "Say exactly: hello world" }],
      max_completion_tokens: 20,
    });

    expect(result.id).toBeDefined();
    expect(result.choices.length).toBeGreaterThan(0);
    expect(result.choices[0].message.content).toBeTruthy();
    expect(result.choices[0].finish_reason).toBeDefined();
  });

  it("completion streams ChatCompletionChunks", async () => {
    const stream = await client.completion({
      model: MODEL,
      messages: [{ role: "user", content: "Say exactly: hi" }],
      max_completion_tokens: 20,
      stream: true,
    });

    const chunks: string[] = [];
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) chunks.push(delta);
    }

    expect(chunks.length).toBeGreaterThan(0);
    const fullContent = chunks.join("");
    expect(fullContent.length).toBeGreaterThan(0);
  });

  it("throws ModelNotFoundError for an invalid model", async () => {
    await expect(
      client.completion({
        model: "nonexistent:fake-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(ModelNotFoundError);
  });
});
