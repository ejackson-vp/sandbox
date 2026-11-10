/**
 * A tiny TCP "Service" for tests.
 *
 * Each accepted connection is pinned to the upstream port that was selected
 * when it connected. Switching the upstream only affects *new* connections,
 * which is how a Kubernetes Service behaves during a rollout: an existing
 * keep-alive socket stays DNAT'd to the old pod even after its endpoint is
 * removed. Tests use this to reproduce the relay-restart split between the
 * controller's admin connection and the guest's fresh dial.
 */
import net from "node:net";

export class TcpRouter {
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private upstreamPort = 0;

  constructor(private readonly host = "127.0.0.1") {
    this.server = net.createServer((down) => {
      const up = net.connect({ host: this.host, port: this.upstreamPort });
      this.sockets.add(down);
      this.sockets.add(up);
      const drop = (): void => {
        down.destroy();
        up.destroy();
        this.sockets.delete(down);
        this.sockets.delete(up);
      };
      down.on("error", drop);
      up.on("error", drop);
      down.on("close", drop);
      up.on("close", drop);
      down.pipe(up);
      up.pipe(down);
    });
  }

  setUpstream(port: number): void {
    this.upstreamPort = port;
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, this.host, () => {
        resolve((this.server.address() as net.AddressInfo).port);
      });
    });
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
