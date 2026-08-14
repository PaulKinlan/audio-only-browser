export class CDPClient {
    ws: WebSocket | null = null;
    messageId = 1;
    pendingRequests = new Map();
    listeners = new Map();

    async connect(wsUrl: string) {
        return new Promise<void>((resolve, reject) => {
            this.ws = new WebSocket(wsUrl);
            this.ws.onopen = () => resolve();
            this.ws.onerror = (err) => reject(err);
            this.ws.onmessage = (event) => this.handleMessage(event.data);
        });
    }

    handleMessage(data: string) {
        const msg = JSON.parse(data);
        if (msg.id && this.pendingRequests.has(msg.id)) {
            const { resolve, reject } = this.pendingRequests.get(msg.id);
            this.pendingRequests.delete(msg.id);
            if (msg.error) {
                reject(new Error(msg.error.message));
            } else {
                resolve(msg.result);
            }
        }
        if (msg.method) {
            const handlers = this.listeners.get(msg.method) || [];
            for (const handler of handlers) {
                handler(msg.params);
            }
        }
    }

    send(method: string, params: any = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.ws) return reject(new Error("No WebSocket connection"));
            const id = this.messageId++;
            this.pendingRequests.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    on(method: string, handler: (params: any) => void) {
        if (!this.listeners.has(method)) {
            this.listeners.set(method, []);
        }
        this.listeners.get(method).push(handler);
    }
}
