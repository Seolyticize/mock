import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMock, type Mock, type MockOptions } from "./index.js";

/** The mock on a port: what `npx @seolyticize/mock` runs. Port 0 picks a free one. */
export async function startMockServer(
  options: MockOptions & { port?: number; host?: string },
): Promise<Mock & { url: string; close(): Promise<void> }> {
  const mock = createMock(options);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const answer = await mock.fetch(
        `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`,
        {
          method: req.method ?? "GET",
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
        },
      );
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      res.end(Buffer.from(await answer.arrayBuffer()));
    });
  });
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((done) => server.listen(options.port ?? 4600, host, done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    ...mock,
    url: `http://${host}:${port}`,
    close: () => new Promise((done) => server.close(() => done())),
  };
}
