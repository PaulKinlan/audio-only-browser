type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type CDPEventHandler = (params: unknown) => void;

export class CDPClient {
  ws: WebSocket | null = null;
  messageId = 1;
  pendingRequests = new Map<number, PendingRequest>();
  listeners = new Map<string, Set<CDPEventHandler>>();

  async connect(wsUrl: string) {
    if (this.ws) this.close();
    return await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`Unable to connect to Chrome at ${wsUrl}`));
      ws.onclose = () => {
        const error = new Error("Chrome DevTools connection closed");
        for (const request of this.pendingRequests.values()) {
          clearTimeout(request.timeout);
          request.reject(error);
        }
        this.pendingRequests.clear();
        if (this.ws === ws) this.ws = null;
      };
      ws.onmessage = (event) => this.handleMessage(String(event.data));
    });
  }

  private handleMessage(data: string) {
    const message = JSON.parse(data);
    if (message.id && this.pendingRequests.has(message.id)) {
      const request = this.pendingRequests.get(message.id)!;
      clearTimeout(request.timeout);
      this.pendingRequests.delete(message.id);
      if (message.error) {
        request.reject(new Error(message.error.message));
      } else {
        request.resolve(message.result);
      }
    }
    if (message.method) {
      for (const handler of this.listeners.get(message.method) ?? []) {
        try {
          handler(message.params);
        } catch (error) {
          console.error(`CDP listener failed for ${message.method}:`, error);
        }
      }
    }
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("No open Chrome DevTools connection"));
        return;
      }
      const id = this.messageId++;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`CDP request timed out: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on<T>(method: string, handler: (params: T) => void) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    const wrapped: CDPEventHandler = (params) => handler(params as T);
    this.listeners.get(method)!.add(wrapped);
    return () => this.listeners.get(method)?.delete(wrapped);
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}
