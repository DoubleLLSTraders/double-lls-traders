import { requestSocketUrl } from "./rest";
import type {
  BaseResponse,
  ConnectionState,
  DerivError,
  OptionsAccount,
} from "./types";

export type DerivTransport = "otp" | "oauth" | "public";

export interface DerivClientOptions {
  appId: string;
  restUrl: string;
  token: string;
  accountId: string;
  /**
   * otp — PAT + REST OTP URL (admin / env tokens).
   * oauth — classic WS + authorize (client Deriv OAuth tokens).
   * public — classic WS, ticks only (visitor preview, no balance).
   */
  transport?: DerivTransport;
  /** Fail a pending request if Deriv has not answered within this many ms. */
  requestTimeoutMs?: number;
}

const CLASSIC_WS = "wss://ws.derivws.com/websockets/v3";

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
  /** Stopped before Deriv sent its id — forget the stream once it arrives. */
  cancelled?: boolean;
}

/** Stream family a request belongs to, for `forget_all` recovery. */
function streamTypeOf(request: Record<string, unknown>): string | null {
  if ("ticks_history" in request || "ticks" in request) return "ticks";
  if ("proposal_open_contract" in request) return "proposal_open_contract";
  if ("proposal" in request) return "proposal";
  if ("balance" in request) return "balance";
  return null;
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
 * Options WebSocket client for Deriv's new PAT + OTP flow.
 *
 * Auth happens outside the socket: REST mints an OTP URL, then this client
 * opens that URL and talks the same ticks / balance / buy protocol as before.
 * On reconnect it always mints a fresh OTP — they expire quickly.
 */
export class DerivClient {
  private readonly options: Required<
    Omit<DerivClientOptions, "transport">
  > & { transport: DerivTransport };
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
  private connectGeneration = 0;

  account: OptionsAccount | null = null;

  constructor(options: DerivClientOptions) {
    this.options = {
      requestTimeoutMs: 20_000,
      transport: "otp",
      ...options,
    };
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
    void this.openSocket();
  }

  disconnect(): void {
    this.closedByUser = true;
    this.connectGeneration += 1;
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
  ): Promise<() => Promise<void>> {
    try {
      const requestId = await this.openStream<T>(request, handler);
      return () => this.unsubscribe(requestId);
    } catch (error) {
      // A stream from an earlier mount or a torn-down socket can outlive its
      // handler, and Deriv then rejects the next subscribe to that symbol with
      // AlreadySubscribed. Drop the orphan and try once more.
      const streamType = streamTypeOf(request);
      if (
        !(error instanceof DerivApiError) ||
        error.code !== "AlreadySubscribed" ||
        streamType === null
      ) {
        throw error;
      }
      await this.forgetAll(streamType);
      const requestId = await this.openStream<T>(request, handler);
      return () => this.unsubscribe(requestId);
    }
  }

  private async openStream<T extends BaseResponse>(
    request: Record<string, unknown>,
    handler: Handler<T>,
  ): Promise<number> {
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

    return requestId;
  }

  private async unsubscribe(requestId: number): Promise<void> {
    const subscription = this.subscriptions.get(requestId);
    if (!subscription || subscription.cancelled) return;

    if (!subscription.subscriptionId) {
      // Deriv has not answered yet, so there is no id to forget. Dropping the
      // entry now would strand the stream server-side and the next subscribe
      // to this symbol would fail — flag it and forget when the id lands.
      subscription.cancelled = true;
      return;
    }

    this.subscriptions.delete(requestId);
    await this.forget(subscription.subscriptionId);
  }

  private async forget(subscriptionId: string): Promise<void> {
    if (this.state !== "ready") return;
    await this.send({ forget: subscriptionId }).catch(() => {
      // A dropped socket already invalidated the subscription server-side.
    });
  }

  private async forgetAll(streamType: string): Promise<void> {
    if (this.state !== "ready") return;
    await this.send({ forget_all: streamType }).catch(() => {
      // Nothing to clear, or the socket went away — the retry will report it.
    });
  }

  private async openSocket(): Promise<void> {
    this.closedByUser = false;
    const generation = ++this.connectGeneration;
    this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "authorizing");

    try {
      let url: string;
      if (this.options.transport === "otp") {
        url = await requestSocketUrl(
          {
            appId: this.options.appId,
            restUrl: this.options.restUrl,
            token: this.options.token,
          },
          this.options.accountId,
        );
      } else {
        url = `${CLASSIC_WS}?app_id=${encodeURIComponent(this.options.appId)}`;
      }

      if (generation !== this.connectGeneration || this.closedByUser) return;

      this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
      const socket = new WebSocket(url);
      this.socket = socket;

      socket.onopen = () => void this.handleOpen(generation);
      socket.onmessage = (event) => this.handleMessage(event);
      socket.onerror = () => this.emitError(new Error("WebSocket transport error."));
      socket.onclose = () => this.handleClose();
    } catch (error) {
      if (generation !== this.connectGeneration || this.closedByUser) return;
      this.emitError(error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
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

  private async handleOpen(generation: number): Promise<void> {
    if (generation !== this.connectGeneration || this.closedByUser) return;

    try {
      if (this.options.transport === "oauth" && this.options.token) {
        const auth = await this.dispatch<{
          authorize?: {
            loginid?: string;
            balance?: number;
            currency?: string;
            is_virtual?: number | boolean;
          };
        }>({ authorize: this.options.token });
        const a = auth.authorize;
        if (a) {
          this.account = {
            accountId: a.loginid ?? this.options.accountId,
            balance: Number(a.balance ?? 0),
            currency: a.currency ?? "USD",
            isVirtual: Boolean(a.is_virtual),
            status: "active",
          };
        }
      }
      if (generation !== this.connectGeneration || this.closedByUser) return;
      this.reconnectAttempts = 0;
      this.setState("ready");
      this.startHeartbeat();
      await this.restoreSubscriptions();
    } catch (error) {
      if (generation !== this.connectGeneration || this.closedByUser) return;
      this.emitError(error instanceof Error ? error : new Error(String(error)));
      try {
        this.socket?.close();
      } catch {
        this.scheduleReconnect();
      }
    }
  }

  private async restoreSubscriptions(): Promise<void> {
    const entries = [...this.subscriptions.entries()];
    this.subscriptions.clear();

    for (const [, subscription] of entries) {
      if (subscription.cancelled) continue;
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
        // Stopped while the subscribe was still in flight — close the stream
        // now that Deriv has named it.
        if (subscription.cancelled) {
          this.subscriptions.delete(requestId);
          void this.forget(message.subscription.id);
        }
      }
      if (!message.error && !subscription.cancelled) {
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

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.setState("reconnecting");
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, MAX_BACKOFF_MS);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      this.send({ ping: 1 }).catch(() => {
        // Half-open sockets stay "ready" with a frozen chart. Force close so
        // handleClose → scheduleReconnect restores the live stream.
        try {
          this.socket?.close();
        } catch {
          this.scheduleReconnect();
        }
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
