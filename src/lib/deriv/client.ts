import type {
  AuthorizeResponse,
  BaseResponse,
  ConnectionState,
  DerivError,
} from "./types";

export interface DerivClientOptions {
  appId: string;
  wsUrl: string;
  token: string;
  /** Fail a pending request if Deriv has not answered within this many ms. */
  requestTimeoutMs?: number;
}

type Handler<T> = (value: T) => void;

interface PendingRequest {
  resolve: (value: BaseResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveSubscription {
  request: Record<string, unknown>;
  handler: Handler<BaseResponse>;
  subscriptionId?: string;
}

export class DerivApiError extends Error {
  readonly code: string;

  constructor(error: DerivError) {
    super(error.message);
    this.name = "DerivApiError";
    this.code = error.code;
  }
}

const HEARTBEAT_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Thin WebSocket wrapper around the Deriv API: correlates requests with
 * responses via `req_id`, keeps subscriptions alive across reconnects, and
 * pings often enough that Deriv does not drop an idle socket.
 */
export class DerivClient {
  private readonly options: Required<DerivClientOptions>;
  private socket: WebSocket | null = null;
  private state: ConnectionState = "idle";
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly subscriptions = new Map<number, ActiveSubscription>();
  private readonly stateListeners = new Set<Handler<ConnectionState>>();
  private readonly errorListeners = new Set<Handler<Error>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private closedByUser = false;

  account: AuthorizeResponse["authorize"] | null = null;

  constructor(options: DerivClientOptions) {
    this.options = { requestTimeoutMs: 20_000, ...options };
  }

  getState(): ConnectionState {
    return this.state;
  }

  onStateChange(listener: Handler<ConnectionState>): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onError(listener: Handler<Error>): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;

    this.closedByUser = false;
    this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");

    const url = `${this.options.wsUrl}?app_id=${encodeURIComponent(this.options.appId)}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => void this.handleOpen();
    socket.onmessage = (event) => this.handleMessage(event);
    socket.onerror = () => this.emitError(new Error("WebSocket transport error."));
    socket.onclose = () => this.handleClose();
  }

  disconnect(): void {
    this.closedByUser = true;
    this.clearTimers();
    this.rejectAllPending(new Error("Client disconnected."));
    this.subscriptions.clear();
    this.socket?.close();
    this.socket = null;
    this.account = null;
    this.setState("closed");
  }

  /** Send a one-shot request and resolve with its response. */
  send<T extends BaseResponse>(request: Record<string, unknown>): Promise<T> {
    return this.dispatch<T>(request);
  }

  /**
   * Open a streaming subscription. `handler` receives every message for it,
   * including the initial snapshot. The returned function stops the stream.
   */
  async subscribe<T extends BaseResponse>(
    request: Record<string, unknown>,
    handler: Handler<T>,
  ): Promise<() => void> {
    const requestId = this.nextRequestId++;
    this.subscriptions.set(requestId, {
      request,
      handler: handler as Handler<BaseResponse>,
    });

    try {
      await this.dispatch<T>({ ...request, subscribe: 1 }, requestId);
    } catch (error) {
      this.subscriptions.delete(requestId);
      throw error;
    }

    return () => void this.unsubscribe(requestId);
  }

  private async unsubscribe(requestId: number): Promise<void> {
    const subscription = this.subscriptions.get(requestId);
    if (!subscription) return;

    this.subscriptions.delete(requestId);
    if (subscription.subscriptionId && this.state === "ready") {
      await this.send({ forget: subscription.subscriptionId }).catch(() => {
        // A dropped socket already invalidated the subscription server-side.
      });
    }
  }

  private dispatch<T extends BaseResponse>(
    request: Record<string, unknown>,
    requestId: number = this.nextRequestId++,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected to Deriv."));
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Deriv did not respond within ${this.options.requestTimeoutMs}ms.`));
      }, this.options.requestTimeoutMs);

      this.pending.set(requestId, {
        resolve: resolve as (value: BaseResponse) => void,
        reject,
        timer,
      });

      socket.send(JSON.stringify({ ...request, req_id: requestId }));
    });
  }

  private async handleOpen(): Promise<void> {
    this.setState("authorizing");

    try {
      const response = await this.dispatch<AuthorizeResponse>({ authorize: this.options.token });
      this.account = response.authorize;
      this.reconnectAttempts = 0;
      this.setState("ready");
      this.startHeartbeat();
      await this.restoreSubscriptions();
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
      // A bad token will never succeed on retry, so stop rather than loop.
      this.closedByUser = true;
      this.setState("error");
      this.socket?.close();
    }
  }

  private async restoreSubscriptions(): Promise<void> {
    const entries = [...this.subscriptions.entries()];
    this.subscriptions.clear();

    for (const [, subscription] of entries) {
      const requestId = this.nextRequestId++;
      this.subscriptions.set(requestId, {
        request: subscription.request,
        handler: subscription.handler,
      });
      await this.dispatch({ ...subscription.request, subscribe: 1 }, requestId).catch((error) => {
        this.subscriptions.delete(requestId);
        this.emitError(error instanceof Error ? error : new Error(String(error)));
      });
    }
  }

  private handleMessage(event: MessageEvent): void {
    let message: BaseResponse;
    try {
      message = JSON.parse(event.data as string) as BaseResponse;
    } catch {
      this.emitError(new Error("Received malformed JSON from Deriv."));
      return;
    }

    const requestId = message.req_id;
    if (requestId === undefined) return;

    const subscription = this.subscriptions.get(requestId);
    if (subscription) {
      if (message.subscription?.id) {
        subscription.subscriptionId = message.subscription.id;
      }
      if (!message.error) {
        subscription.handler(message);
      }
    }

    const pendingRequest = this.pending.get(requestId);
    if (!pendingRequest) return;

    clearTimeout(pendingRequest.timer);
    this.pending.delete(requestId);

    if (message.error) {
      this.subscriptions.delete(requestId);
      pendingRequest.reject(new DerivApiError(message.error));
    } else {
      pendingRequest.resolve(message);
    }
  }

  private handleClose(): void {
    this.clearTimers();
    this.rejectAllPending(new Error("Connection to Deriv closed."));
    this.socket = null;

    if (this.closedByUser) {
      if (this.state !== "error") this.setState("closed");
      return;
    }

    this.setState("reconnecting");
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, MAX_BACKOFF_MS);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      this.send({ ping: 1 }).catch(() => {
        // The close handler drives reconnection; a failed ping needs no action.
      });
    }, HEARTBEAT_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private rejectAllPending(reason: Error): void {
    for (const [, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(reason);
    }
    this.pending.clear();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}
