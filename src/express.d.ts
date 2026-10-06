/**
 * Minimal ambient types for the `express` package.
 *
 * `express` arrives transitively via `stremio-addon-sdk` and ships no
 * TypeScript declarations; adding `@types/express` would be a new
 * dependency, which Phase 1 forbids. This shim declares only what the
 * composition root uses. It is deliberately structural: the app must be
 * passable to `node:http`'s `createServer` and to `supertest`, both of
 * which accept any `RequestListener`.
 */
declare module 'express' {
  type RequestListener = import('node:http').RequestListener;
  type IncomingMessage = import('node:http').IncomingMessage;
  type ServerResponse = import('node:http').ServerResponse;

  namespace express {
    type NextFunction = (err?: unknown) => void;

    interface RequestHandler {
      (req: IncomingMessage, res: ServerResponse, next: NextFunction): void;
    }

    interface Express extends RequestListener {
      use(...handlers: RequestHandler[]): Express;
      use(path: string, ...handlers: RequestHandler[]): Express;
    }

    interface ServeStaticOptions {
      maxAge?: number | string;
      fallthrough?: boolean;
    }
  }

  const express: {
    (): express.Express;
    static(root: string, options?: express.ServeStaticOptions): RequestListener;
  };

  export default express;
}
