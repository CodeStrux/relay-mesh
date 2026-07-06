/**
 * FakeLlmClient — scripted LlmClient for tests. Zero network.
 * Queue responses per model id (or "*" catch-all); inject failures, timeouts,
 * and malformed ("garbage") outputs; every call is recorded for assertions.
 */
import type { LlmCallOpts, LlmClient, LlmResult } from "../../src/openrouter.js";

export type ScriptedResponse =
  | { kind: "text"; text: string; chunks?: string[]; usage?: { in: number; out: number } }
  | { kind: "failure"; error?: Error }
  | { kind: "timeout" };

export class FakeLlmClient implements LlmClient {
  readonly calls: LlmCallOpts[] = [];
  models: string[] = [];
  private readonly queues = new Map<string, ScriptedResponse[]>();

  /** Queue responses under a model id (or "*"). Bare strings are text responses. */
  script(key: string, ...responses: (ScriptedResponse | string)[]): this {
    const queue = this.queues.get(key) ?? [];
    for (const r of responses) {
      queue.push(typeof r === "string" ? { kind: "text", text: r } : r);
    }
    this.queues.set(key, queue);
    return this;
  }

  async complete(opts: LlmCallOpts): Promise<LlmResult> {
    this.calls.push(opts);
    const queue = this.queues.get(opts.model) ?? this.queues.get("*");
    const next = queue?.shift();
    if (!next) {
      throw new Error(`FakeLlmClient: no scripted response for model "${opts.model}"`);
    }
    if (next.kind === "failure") {
      throw next.error ?? new Error("FakeLlmClient: scripted failure");
    }
    if (next.kind === "timeout") {
      // Mimic AbortSignal.timeout(): the SDK surfaces a TimeoutError-named abort.
      const err = new Error(`FakeLlmClient: scripted timeout after ${opts.timeoutMs}ms`);
      err.name = "TimeoutError";
      throw err;
    }
    const chunks = next.chunks ?? [next.text];
    for (const chunk of chunks) opts.onChunk?.(chunk);
    return { text: chunks.join(""), usage: next.usage ?? { in: 0, out: 0 } };
  }

  async listModels(): Promise<string[]> {
    return [...this.models];
  }
}
