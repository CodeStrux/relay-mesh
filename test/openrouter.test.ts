import { describe, expect, it } from "vitest";
import {
  makeOpenRouterClient,
  mapEffort,
  shouldStripReasoning,
  type LlmCallOpts,
} from "../src/openrouter.js";
import { FakeLlmClient } from "./fakes/llm.js";

describe("mapEffort", () => {
  it("passes low/medium/high through", () => {
    expect(mapEffort("low")).toEqual({ effort: "low" });
    expect(mapEffort("medium")).toEqual({ effort: "medium" });
    expect(mapEffort("high")).toEqual({ effort: "high" });
  });

  it("maps xhigh to high (OpenRouter has no xhigh)", () => {
    expect(mapEffort("xhigh")).toEqual({ effort: "high" });
  });
});

describe("shouldStripReasoning", () => {
  it("matches a 400 whose message mentions reasoning, case-insensitively", () => {
    expect(shouldStripReasoning({ status: 400, message: "Invalid parameter: reasoning" })).toBe(true);
    expect(shouldStripReasoning({ status: 400, message: "Reasoning is not supported" })).toBe(true);
  });

  it("ignores 400s about anything else", () => {
    expect(shouldStripReasoning({ status: 400, message: "context length exceeded" })).toBe(false);
  });

  it("ignores non-400 statuses even when the message mentions reasoning", () => {
    expect(shouldStripReasoning({ status: 500, message: "reasoning backend down" })).toBe(false);
  });

  it("ignores non-error shapes", () => {
    expect(shouldStripReasoning(null)).toBe(false);
    expect(shouldStripReasoning("reasoning")).toBe(false);
    expect(shouldStripReasoning({ message: "reasoning" })).toBe(false);
  });
});

describe("makeOpenRouterClient", () => {
  it("builds an LlmClient without touching the network", () => {
    const client = makeOpenRouterClient({
      apiKey: "test",
      baseUrl: "https://openrouter.ai/api/v1",
      referer: "https://github.com/CodeStrux/relay-mesh",
      title: "relay-mesh",
    });
    expect(typeof client.complete).toBe("function");
    expect(typeof client.listModels).toBe("function");
  });
});

function callOpts(model: string, extra: Partial<LlmCallOpts> = {}): LlmCallOpts {
  return {
    model,
    effort: "low",
    system: "system prompt",
    user: [{ type: "text", text: "hello" }],
    timeoutMs: 1_000,
    ...extra,
  };
}

describe("FakeLlmClient (the shared test seam)", () => {
  it("returns scripted responses per model in queue order and records calls", async () => {
    const fake = new FakeLlmClient();
    fake.script("model-a", "first", "second").script("model-b", "other");
    expect((await fake.complete(callOpts("model-a"))).text).toBe("first");
    expect((await fake.complete(callOpts("model-b"))).text).toBe("other");
    expect((await fake.complete(callOpts("model-a"))).text).toBe("second");
    expect(fake.calls.map((c) => c.model)).toEqual(["model-a", "model-b", "model-a"]);
    expect(fake.calls[0]?.system).toBe("system prompt");
  });

  it("streams chunks through onChunk and joins them as the result text", async () => {
    const fake = new FakeLlmClient();
    fake.script("m", { kind: "text", text: "", chunks: ["ab", "cd", "e"], usage: { in: 10, out: 5 } });
    const seen: string[] = [];
    const result = await fake.complete(callOpts("m", { onChunk: (t) => seen.push(t) }));
    expect(seen).toEqual(["ab", "cd", "e"]);
    expect(result.text).toBe("abcde");
    expect(result.usage).toEqual({ in: 10, out: 5 });
  });

  it("injects failures", async () => {
    const fake = new FakeLlmClient();
    fake.script("m", { kind: "failure", error: new Error("boom") });
    await expect(fake.complete(callOpts("m"))).rejects.toThrow("boom");
  });

  it("injects timeouts as TimeoutError-named aborts", async () => {
    const fake = new FakeLlmClient();
    fake.script("m", { kind: "timeout" });
    const err = await fake.complete(callOpts("m")).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("TimeoutError");
  });

  it("serves garbage output verbatim (malformed executor wire format)", async () => {
    const fake = new FakeLlmClient();
    fake.script("m", "not a FILE block at all ===");
    expect((await fake.complete(callOpts("m"))).text).toBe("not a FILE block at all ===");
  });

  it("falls back to the * catch-all queue and throws when unscripted", async () => {
    const fake = new FakeLlmClient();
    fake.script("*", "anything");
    expect((await fake.complete(callOpts("unknown-model"))).text).toBe("anything");
    await expect(fake.complete(callOpts("unknown-model"))).rejects.toThrow(/no scripted response/);
  });

  it("lists scripted models", async () => {
    const fake = new FakeLlmClient();
    fake.models = ["a/one", "b/two"];
    expect(await fake.listModels()).toEqual(["a/one", "b/two"]);
  });
});
