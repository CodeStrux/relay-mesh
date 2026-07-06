/**
 * ONE OpenAI-SDK client pointed at OpenRouter. Streaming, attribution headers,
 * effort→reasoning mapping, timeout via AbortSignal, retry-once-before-first-chunk.
 */
import OpenAI from "openai";

export type Effort = "low" | "medium" | "high" | "xhigh";

export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } } // data: URLs for local files
  | { type: "video_url"; video_url: { url: string } };

export interface LlmCallOpts {
  model: string;
  effort: Effort;
  system: string;
  user: LlmContentPart[];
  maxOutputTokens?: number;
  timeoutMs: number;
  onChunk?: (text: string) => void; // streaming hook
}

export interface LlmResult {
  text: string;
  usage: { in: number; out: number };
}

export interface LlmClient {
  complete(opts: LlmCallOpts): Promise<LlmResult>;
  listModels(): Promise<string[]>;
}

/** OpenRouter reasoning mapping; "xhigh" is our profile extension, sent as "high". */
export function mapEffort(effort: Effort): { effort: "low" | "medium" | "high" } {
  return { effort: effort === "xhigh" ? "high" : effort };
}

/** True for an HTTP 400 whose message mentions "reasoning" — models that reject the param. */
export function shouldStripReasoning(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; message?: unknown };
  return (
    e.status === 400 &&
    typeof e.message === "string" &&
    e.message.toLowerCase().includes("reasoning")
  );
}

export function makeOpenRouterClient(cfg: {
  apiKey: string;
  baseUrl: string;
  referer: string;
  title: string;
}): LlmClient {
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    defaultHeaders: {
      // OpenRouter attribution headers.
      "HTTP-Referer": cfg.referer,
      "X-Title": cfg.title,
    },
  });

  function requestBody(
    opts: LlmCallOpts,
    withReasoning: boolean,
  ): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
    const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
      model: opts.model,
      messages: [
        { role: "system", content: opts.system },
        {
          role: "user",
          // video_url is OpenRouter passthrough the SDK types don't know about.
          content: opts.user as unknown as OpenAI.Chat.Completions.ChatCompletionContentPart[],
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
    };
    if (opts.maxOutputTokens !== undefined) body.max_tokens = opts.maxOutputTokens;
    // "reasoning" is an OpenRouter extension field the SDK types don't know about.
    if (withReasoning) {
      (body as unknown as Record<string, unknown>).reasoning = mapEffort(opts.effort);
    }
    return body;
  }

  return {
    async complete(opts) {
      let withReasoning = true;
      let retriedOnce = false;
      for (;;) {
        const signal = AbortSignal.timeout(opts.timeoutMs);
        let streamedAny = false;
        try {
          const stream = await client.chat.completions.create(
            requestBody(opts, withReasoning),
            { signal },
          );
          let text = "";
          let usage = { in: 0, out: 0 };
          for await (const chunk of stream) {
            streamedAny = true;
            const delta = chunk.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              text += delta;
              opts.onChunk?.(delta);
            }
            // usage arrives on the final chunk with stream_options.include_usage.
            if (chunk.usage) {
              usage = {
                in: chunk.usage.prompt_tokens ?? 0,
                out: chunk.usage.completion_tokens ?? 0,
              };
            }
          }
          return { text, usage };
        } catch (err) {
          if (signal.aborted) throw err; // timed out — never retry on abort
          if (streamedAny) throw err; // tokens already flowed — no clean retry
          if (withReasoning && shouldStripReasoning(err)) {
            withReasoning = false;
            console.error(
              `relay-mesh: ${opts.model} rejected the reasoning param — retrying once without it`,
            );
            continue;
          }
          if (!retriedOnce) {
            retriedOnce = true;
            continue;
          }
          throw err;
        }
      }
    },

    async listModels() {
      const ids: string[] = [];
      for await (const model of client.models.list()) ids.push(model.id);
      return ids;
    },
  };
}
