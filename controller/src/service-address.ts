/**
 * Short-lived service address cache.
 *
 * Most Services are stable (the proxy is the only other user today), so two
 * Kubernetes reads per provision are wasteful. The relay is deliberately not
 * cacheable: its address is a ready endpoint Pod IP, and a relay replacement
 * changes that IP. Caching it across a restart points new guests at a dead
 * process.
 */
interface ServiceAddress {
  host: string;
  port: number;
}

interface CachedAddress extends ServiceAddress {
  at: number;
}

export class ServiceAddressResolver {
  private readonly cache = new Map<string, CachedAddress>();

  constructor(
    private readonly now: () => number,
    private readonly ttlMs = 30_000,
  ) {}

  async resolve(
    name: string,
    load: () => Promise<ServiceAddress | null>,
    opts: { cache: boolean },
  ): Promise<ServiceAddress | null> {
    if (!opts.cache) return load();
    const cached = this.cache.get(name);
    if (cached && this.now() - cached.at < this.ttlMs) {
      return { host: cached.host, port: cached.port };
    }
    const addr = await load();
    if (addr) this.cache.set(name, { ...addr, at: this.now() });
    return addr;
  }

  clear(): void {
    this.cache.clear();
  }
}
