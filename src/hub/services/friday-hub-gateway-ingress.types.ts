export type FridayWsFrame =
  | FridayWsReqFrame
  | FridayWsResFrame
  | FridayWsEventFrame
  | FridayWsAckFrame
  | FridayWsResumeFrame;

export interface FridayWsReqFrame {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
  idempotencyKey?: string;
  traceId?: string;
}

export interface FridayWsResFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
  };
}

export interface FridayWsEventFrame {
  type: "event";
  event: string;
  seq: number;
  payload?: unknown;
  emittedAt: string;
}

export interface FridayWsAckFrame {
  type: "ack";
  seq: number;
  streamId: string;
  epoch: number;
  emittedAt: string;
}

export interface FridayWsResumeFrame {
  type: "resume";
  lastAckedSeq: number;
  streamId: string;
  epoch: number;
  cursor: string;
  subscriptions: string[];
  emittedAt: string;
}

export interface FridayGatewayRequestContext {
  principalType: "user" | "satellite" | "service" | "workflow-runner";
  principalId?: string;
  scopes: string[];
  connectionId?: string;
  traceId?: string;
}

export type FridayGatewayMethodHandler<TParams = unknown, TResult = unknown> = (
  params: TParams,
  context: FridayGatewayRequestContext,
) => Promise<TResult>;

export interface FridayHubGatewayIngressService {
  registerMethod<TParams = unknown, TResult = unknown>(
    method: string,
    handler: FridayGatewayMethodHandler<TParams, TResult>,
  ): void;
  dispatchFrame(
    frame: FridayWsFrame,
    context: FridayGatewayRequestContext,
  ): Promise<FridayWsResFrame | null>;
  publishEvent(frame: FridayWsEventFrame): Promise<void>;
}
