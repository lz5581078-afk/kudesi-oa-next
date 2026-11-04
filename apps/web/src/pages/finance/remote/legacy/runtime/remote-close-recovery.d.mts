interface CloseState { browserStatus?: string; status?: string; closeStage?: string; error?: string }
export function browserCloseConfirmed(session: CloseState | null | undefined): boolean;
export function pendingBrowserClose(browser: unknown): unknown;
export function pollBrowserClose(options: {
  sessionId: string;
  fetchJson: (path: string, options?: RequestInit) => Promise<any>;
  onUpdate?: (state: CloseState) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<CloseState>;
export function fetchCloseJson(fetchJson: (path: string, options?: RequestInit) => Promise<any>, path: string, options?: RequestInit, timeoutMs?: number): Promise<any>;
