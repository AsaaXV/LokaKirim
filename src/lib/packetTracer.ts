export enum TraceLevel {
  Trace = 'TRACE',
  Debug = 'DEBUG',
  Info = 'INFO',
  Warn = 'WARN',
  Error = 'ERROR',
}

export enum TraceTarget {
  UiSend = 'ui::send',
  SyncKey = 'sync::key',
  SyncEncrypt = 'sync::encrypt',
  SyncDecrypt = 'sync::decrypt',
  SyncQueue = 'sync::queue',
  SyncAck = 'sync::ack',
  TransportRustWs = 'transport::rust_ws',
  TransportBrowserWs = 'transport::browser_ws',
  HostProbe = 'host::probe',
}

export enum PacketErrorCode {
  KeyMissing = 'KEY_MISSING',
  SocketClosed = 'SOCKET_CLOSED',
  SendRejected = 'SEND_REJECTED',
  EncryptFailed = 'ENCRYPT_FAILED',
  DecryptMismatch = 'DECRYPT_MISMATCH',
  AckTimeout = 'ACK_TIMEOUT',
  ZeroRecipients = 'ZERO_RECIPIENTS',
  RustIpcError = 'RUST_IPC_ERROR',
}

export type TraceFields = Record<string, string | number | boolean | null | undefined>;

export interface PacketError {
  code: PacketErrorCode;
  message: string;
  fields?: TraceFields;
}

export type PacketResult<T, E = PacketError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): PacketResult<T, never> {
  return { ok: true, value };
}

export function err<E = PacketError>(error: E): PacketResult<never, E> {
  return { ok: false, error };
}

export interface PacketTraceEntry {
  seq: number;
  tsIso: string;
  tsMs: number;
  level: TraceLevel;
  target: TraceTarget;
  event: string;
  msgId?: string;
  convId?: string;
  elapsedMs?: number;
  errorCode?: PacketErrorCode;
  fields?: TraceFields;
}

interface ActiveSpan {
  msgId: string;
  convId: string;
  startedPerf: number;
  timerId: number | null;
}

const MAX_TRACE_ENTRIES = 250;

function formatFields(fields?: TraceFields): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (typeof v === 'string') {
      const safe = v.includes(' ') ? `"${v}"` : v;
      parts.push(`${k}=${safe}`);
    } else {
      parts.push(`${k}=${String(v)}`);
    }
  }
  return parts.join(' ');
}

export function formatTraceEntryLine(entry: PacketTraceEntry): string {
  const head = `${entry.tsIso} ${entry.level.padEnd(5)} ${entry.target}: ${entry.event}`;
  const meta: TraceFields = {
    ...(entry.msgId ? { msg_id: entry.msgId } : {}),
    ...(entry.convId ? { conv_id: entry.convId } : {}),
    ...(entry.elapsedMs !== undefined ? { elapsed_ms: entry.elapsedMs } : {}),
    ...(entry.errorCode ? { err: entry.errorCode } : {}),
    ...(entry.fields || {}),
  };
  const suffix = formatFields(meta);
  return suffix ? `${head} { ${suffix} }` : head;
}

export interface PacketTracerOptions {
  onRustForward?: (entry: PacketTraceEntry) => void;
  onUpdate?: (entries: PacketTraceEntry[], lastFailure: PacketTraceEntry | null) => void;
}

export class PacketTracer {
  private seq = 0;
  private buffer: PacketTraceEntry[] = [];
  private activeSpans = new Map<string, ActiveSpan>();
  private lastFailure: PacketTraceEntry | null = null;
  private options: PacketTracerOptions;

  constructor(options: PacketTracerOptions = {}) {
    this.options = options;
  }

  private pushEntry(entry: PacketTraceEntry) {
    this.buffer.push(entry);
    if (this.buffer.length > MAX_TRACE_ENTRIES) {
      this.buffer.shift();
    }

    if (entry.level === TraceLevel.Warn || entry.level === TraceLevel.Error) {
      this.lastFailure = entry;
    }

    const line = formatTraceEntryLine(entry);
    if (entry.level === TraceLevel.Error) {
      console.error(line);
    } else if (entry.level === TraceLevel.Warn) {
      console.warn(line);
    } else if (entry.level === TraceLevel.Info) {
      console.info(line);
    } else {
      console.debug(line);
    }

    if (
      this.options.onRustForward &&
      (entry.level === TraceLevel.Info ||
        entry.level === TraceLevel.Warn ||
        entry.level === TraceLevel.Error)
    ) {
      this.options.onRustForward(entry);
    }

    this.options.onUpdate?.(this.snapshot(), this.lastFailure);
  }

  log(
    level: TraceLevel,
    target: TraceTarget,
    event: string,
    fields?: TraceFields,
    ids?: { msgId?: string; convId?: string; elapsedMs?: number; errorCode?: PacketErrorCode }
  ): PacketTraceEntry {
    const now = Date.now();
    const entry: PacketTraceEntry = {
      seq: ++this.seq,
      tsIso: new Date(now).toISOString(),
      tsMs: now,
      level,
      target,
      event,
      msgId: ids?.msgId,
      convId: ids?.convId,
      elapsedMs: ids?.elapsedMs,
      errorCode: ids?.errorCode,
      fields,
    };
    this.pushEntry(entry);
    return entry;
  }

  trace(target: TraceTarget, event: string, fields?: TraceFields, msgId?: string) {
    return this.log(TraceLevel.Trace, target, event, fields, { msgId });
  }

  debug(target: TraceTarget, event: string, fields?: TraceFields, msgId?: string) {
    return this.log(TraceLevel.Debug, target, event, fields, { msgId });
  }

  info(
    target: TraceTarget,
    event: string,
    fields?: TraceFields,
    ids?: { msgId?: string; convId?: string; elapsedMs?: number }
  ) {
    return this.log(TraceLevel.Info, target, event, fields, ids);
  }

  warn(
    target: TraceTarget,
    event: string,
    errorCode: PacketErrorCode,
    fields?: TraceFields,
    ids?: { msgId?: string; convId?: string; elapsedMs?: number }
  ) {
    return this.log(TraceLevel.Warn, target, event, fields, { ...ids, errorCode });
  }

  error(
    target: TraceTarget,
    event: string,
    errorCode: PacketErrorCode,
    fields?: TraceFields,
    ids?: { msgId?: string; convId?: string; elapsedMs?: number }
  ) {
    return this.log(TraceLevel.Error, target, event, fields, { ...ids, errorCode });
  }

  startMessageSpan(
    msgId: string,
    convId: string,
    fields?: TraceFields,
    onAckTimeout?: (elapsedMs: number) => TraceFields
  ) {
    const prev = this.activeSpans.get(msgId);
    if (prev?.timerId !== null && prev?.timerId !== undefined) {
      window.clearTimeout(prev.timerId);
    }

    const startedPerf = performance.now();
    const timerId = onAckTimeout
      ? window.setTimeout(() => {
          const span = this.activeSpans.get(msgId);
          if (!span) return;
          const elapsedMs = Math.round(performance.now() - span.startedPerf);
          const extraFields = onAckTimeout(elapsedMs);
          this.warn(
            TraceTarget.SyncAck,
            'ack_timeout_no_host_confirmation',
            PacketErrorCode.AckTimeout,
            extraFields,
            { msgId, convId, elapsedMs }
          );
          this.activeSpans.delete(msgId);
        }, 5000)
      : null;

    this.activeSpans.set(msgId, { msgId, convId, startedPerf, timerId });
    this.info(TraceTarget.UiSend, 'packet_span_open', fields, { msgId, convId });
  }

  finishMessageSpan(
    msgId: string,
    recipientCount?: number,
    extraFields?: TraceFields
  ) {
    const span = this.activeSpans.get(msgId);
    const elapsedMs = span ? Math.round(performance.now() - span.startedPerf) : undefined;
    if (span) {
      if (span.timerId !== null) {
        window.clearTimeout(span.timerId);
      }
      this.activeSpans.delete(msgId);
    }

    if (recipientCount === 0) {
      this.warn(
        TraceTarget.SyncAck,
        'host_acked_zero_recipients',
        PacketErrorCode.ZeroRecipients,
        { recipient_count: 0, ...extraFields },
        { msgId, convId: span?.convId, elapsedMs }
      );
      return;
    }

    this.info(
      TraceTarget.SyncAck,
      'packet_ack_confirmed',
      {
        ...(recipientCount !== undefined ? { recipient_count: recipientCount } : {}),
        ...extraFields,
      },
      { msgId, convId: span?.convId, elapsedMs }
    );
  }

  cancelSpan(msgId: string) {
    const span = this.activeSpans.get(msgId);
    if (span?.timerId !== null && span?.timerId !== undefined) {
      window.clearTimeout(span.timerId);
    }
    this.activeSpans.delete(msgId);
  }

  snapshot(): PacketTraceEntry[] {
    return [...this.buffer];
  }

  getLastFailure(): PacketTraceEntry | null {
    return this.lastFailure;
  }

  clear() {
    for (const span of this.activeSpans.values()) {
      if (span.timerId !== null) window.clearTimeout(span.timerId);
    }
    this.activeSpans.clear();
    this.buffer = [];
    this.lastFailure = null;
    this.options.onUpdate?.([], null);
  }

  formatReport(limit = 60): string {
    const entries = this.buffer.slice(-limit);
    return entries.map(formatTraceEntryLine).join('\n');
  }

  destroy() {
    for (const span of this.activeSpans.values()) {
      if (span.timerId !== null) window.clearTimeout(span.timerId);
    }
    this.activeSpans.clear();
  }
}
