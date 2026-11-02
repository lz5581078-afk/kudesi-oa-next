export const ASSISTANT_KEY = 'feishu-assistant';
export const ASSISTANT_CHANNEL = 'feishu_assistant';
export const MORNING_TEXT = '早上好 ☀️ 新的一天开始啦！小白OA 助手祝大家工作顺利。';
export const WELCOME_TEXT = '欢迎加入我们 🎉 我是小白OA 助手，很高兴认识你！祝你在这里工作顺利、收获满满。';

export interface AssistantConfig {
  appId: string;
  appSecret: string;
  tenantKey: string;
  enabled: boolean;
  morningEnabled: boolean;
  welcomeEnabled: boolean;
  morningText: string;
  welcomeText: string;
  departmentIds: string[];
  activatedAt: string;
}

/** UTC+8 has no daylight saving time. Never use the server's local timezone. */
export function beijingClock(now: Date) {
  const iso = new Date(now.getTime() + 8 * 3600_000).toISOString();
  return { date: iso.slice(0, 10), hour: Number(iso.slice(11, 13)), minute: Number(iso.slice(14, 16)) };
}
export function morningDue(now: Date, activatedAt: string) {
  const t = beijingClock(now);
  // Start from the next scheduled 08:00 after enabling. Never replay old mornings.
  const due = new Date(`${t.date}T08:00:00+08:00`).getTime();
  return t.hour === 8 && t.minute < 10 && due >= new Date(activatedAt).getTime();
}
