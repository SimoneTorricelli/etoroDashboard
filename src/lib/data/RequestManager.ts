export type RequestPriority = 'account' | 'visible' | 'history';
export type RequestLane = 'default' | 'candles';

export interface RequestOptions {
  ttlMs?: number;
  priority?: RequestPriority;
  lane?: RequestLane;
  signal?: AbortSignal;
  force?: boolean;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface QueueItem<T> {
  key: string;
  priority: number;
  lane: RequestLane;
  signal?: AbortSignal;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class RateLimitError extends Error {
  readonly retryAt: number;

  constructor(retryAt: number, message = 'Rate limit eToro') {
    super(message);
    this.name = 'RateLimitError';
    this.retryAt = retryAt;
  }
}

const PRIORITY: Record<RequestPriority, number> = {
  account: 0,
  visible: 1,
  history: 2,
};

/**
 * Unico scheduler per le richieste eToro: deduplica, cache TTL, priorità,
 * concorrenza limitata e circuit breaker. Le candles hanno una corsia
 * separata con massimo due richieste contemporanee.
 */
export class RequestManager {
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly queue: QueueItem<unknown>[] = [];
  private readonly active: Record<RequestLane, number> = { default: 0, candles: 0 };
  private readonly limits: Record<RequestLane, number> = { default: 4, candles: 2 };
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private blockedUntil = 0;

  request<T>(key: string, execute: () => Promise<T>, options: RequestOptions = {}): Promise<T> {
    const now = Date.now();
    const cached = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!options.force && cached && cached.expiresAt > now) return Promise.resolve(cached.value);

    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    if (options.signal?.aborted) return Promise.reject(new DOMException('Richiesta annullata', 'AbortError'));
    if (this.circuitOpenUntil > now) {
      return Promise.reject(new Error(`Circuito API temporaneamente sospeso fino alle ${new Date(this.circuitOpenUntil).toLocaleTimeString('it-IT')}`));
    }

    const lane = options.lane ?? 'default';
    const promise = new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = {
        key,
        priority: PRIORITY[options.priority ?? 'visible'],
        lane,
        signal: options.signal,
        execute,
        resolve,
        reject,
      };
      this.queue.push(item as QueueItem<unknown>);
      this.queue.sort((a, b) => a.priority - b.priority);
      this.pump();
    }).then((value) => {
      const ttlMs = options.ttlMs ?? 0;
      if (ttlMs > 0) this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    }).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  noteRateLimit(retryAfterHeader: string | null): RateLimitError {
    const seconds = Number(retryAfterHeader);
    const retryAt = Number.isFinite(seconds) && seconds > 0
      ? Date.now() + seconds * 1000
      : Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(this.consecutiveFailures, 5)) + Math.round(Math.random() * 750);
    this.blockedUntil = Math.max(this.blockedUntil, retryAt);
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= 3) this.circuitOpenUntil = retryAt;
    return new RateLimitError(retryAt);
  }

  noteSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }

  clear(prefix?: string): void {
    if (!prefix) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.cache.delete(key);
  }

  getStats() {
    return {
      queued: this.queue.length,
      inFlight: this.inFlight.size,
      cached: this.cache.size,
      blockedUntil: this.blockedUntil,
      circuitOpenUntil: this.circuitOpenUntil,
    };
  }

  private pump(): void {
    if (this.blockedUntil > Date.now()) {
      window.setTimeout(() => this.pump(), Math.max(50, this.blockedUntil - Date.now()));
      return;
    }
    for (let index = 0; index < this.queue.length;) {
      const item = this.queue[index];
      if (this.active[item.lane] >= this.limits[item.lane]) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      if (item.signal?.aborted) {
        item.reject(new DOMException('Richiesta annullata', 'AbortError'));
        continue;
      }
      this.active[item.lane] += 1;
      void item.execute()
        .then((value) => {
          this.noteSuccess();
          item.resolve(value);
        })
        .catch(item.reject)
        .finally(() => {
          this.active[item.lane] -= 1;
          this.pump();
        });
    }
  }
}
