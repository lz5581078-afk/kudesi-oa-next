export interface VisionConfig {
  /** OpenAI 兼容接口的根地址，如 https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
}

/** 调用 OpenAI 兼容的 chat/completions 接口；图片以 data URL 传入。可注入 fetch 便于测试。 */
export class VisionClient {
  constructor(
    private readonly cfg: VisionConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async chat(content: unknown): Promise<string> {
    const res = await this.fetchFn(`${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({ model: this.cfg.model, temperature: 0, messages: [{ role: 'user', content }] }),
      signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`识别接口返回 ${res.status}：${text.slice(0, 200)}`);
    let data: { choices?: Array<{ message?: { content?: string } }> };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('识别接口返回的不是 JSON');
    }
    const reply = data.choices?.[0]?.message?.content;
    if (!reply) throw new Error('识别接口没有返回内容');
    return reply;
  }

  /** 连通性测试：不带图片，只问一句。 */
  ping(): Promise<string> {
    return this.chat('只回复两个字母：OK');
  }

  /** 只有文字（从 Excel/CSV 读出来的内容）时用 */
  recognizeText(prompt: string): Promise<string> {
    return this.chat(prompt);
  }

  recognize(prompt: string, imageDataUrl: string): Promise<string> {
    return this.chat([
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: imageDataUrl } },
    ]);
  }
}

/** 从模型回复里取出 JSON（兼容 ```json 代码块和前后多余文字）。 */
export function extractJson(reply: string): Record<string, unknown> | null {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : reply).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
