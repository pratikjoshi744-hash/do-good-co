// Minimal HTTP helpers: body parsing, JSON responses, and a tiny Express-like
// router built entirely on node:http so the server has zero npm dependencies.

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function ok(res, data, meta) {
  sendJson(res, 200, meta ? { data, meta } : { data });
}

export function created(res, data) {
  sendJson(res, 201, { data });
}

export function fail(res, status, message, details) {
  sendJson(res, status, { error: { message, details: details ?? null } });
}

// 20MB accommodates a base64-encoded short video clip alongside the JSON envelope
// (client enforces a smaller raw-file limit before encoding — see MAX_* in QuestDetail.js).
const MAX_BODY_BYTES = 20_000_000;

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// --- Tiny router -----------------------------------------------------------

function compilePath(path) {
  const paramNames = [];
  const pattern = path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^/${pattern}/?$`), paramNames };
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, path, ...handlers) {
    const { regex, paramNames } = compilePath(path);
    this.routes.push({ method, regex, paramNames, handlers });
    return this;
  }

  get(path, ...h) { return this.add('GET', path, ...h); }
  post(path, ...h) { return this.add('POST', path, ...h); }
  patch(path, ...h) { return this.add('PATCH', path, ...h); }
  put(path, ...h) { return this.add('PUT', path, ...h); }
  delete(path, ...h) { return this.add('DELETE', path, ...h); }

  async handle(req, res, pathname, query) {
    const candidates = this.routes.filter((r) => r.method === req.method);
    for (const route of candidates) {
      const match = route.regex.exec(pathname);
      if (!match) continue;
      const params = {};
      route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
      req.params = params;
      req.query = query;
      try {
        for (const handler of route.handlers) {
          let nextCalled = false;
          const next = () => { nextCalled = true; };
          await handler(req, res, next);
          if (res.writableEnded) return true;
          if (!nextCalled) return true;
        }
        return true;
      } catch (err) {
        if (err instanceof HttpError) {
          fail(res, err.status, err.message, err.details);
        } else {
          console.error(err);
          fail(res, 500, 'Internal server error');
        }
        return true;
      }
    }
    return false;
  }
}
