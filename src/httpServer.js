import http from 'node:http';
import { verifyOwnTracksAuth, upsertLocation } from './owntracks.js';

const MAX_BODY_BYTES = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBasicAuth(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx === -1) return null;
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

function requireAuth(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="owntracks"', 'Content-Type': 'application/json' });
  res.end('[]');
}

// Rate limit sederhana per user, in-memory (cukup untuk skala keluarga single-instance).
function createRateLimiter(minIntervalMs) {
  const lastSeen = new Map();
  return (key) => {
    const now = Date.now();
    const last = lastSeen.get(key);
    if (last != null && now - last < minIntervalMs) return false;
    lastSeen.set(key, now);
    return true;
  };
}

async function handleOwnTracksPub(req, res, logger, allowRequest) {
  const auth = parseBasicAuth(req);
  if (!auth) return requireAuth(res);

  const user = await verifyOwnTracksAuth(auth.username, auth.password);
  if (!user) {
    logger.warn({ username: auth.username }, 'OwnTracks auth gagal');
    return requireAuth(res);
  }

  if (!allowRequest(auth.username)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    return res.end('[]');
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    logger.warn({ err }, 'OwnTracks body error');
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end('[]');
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end('[]');
  }

  if (payload._type === 'location' && typeof payload.lat === 'number' && typeof payload.lon === 'number') {
    upsertLocation({
      userId: auth.username,
      latitude: payload.lat,
      longitude: payload.lon,
      accuracy: typeof payload.acc === 'number' ? payload.acc : null,
      battery: typeof payload.batt === 'number' ? payload.batt : null,
      updatedAt: typeof payload.tst === 'number' ? payload.tst * 1000 : Date.now(),
    });
    logger.info({ username: auth.username }, 'Lokasi OwnTracks diperbarui');
  }

  // OwnTracks HTTP mode wajib dibalas 200 dengan array kosong, apapun _type-nya.
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('[]');
}

export function startHttpServer(env, logger) {
  const port = Number(env.HTTP_PORT || 3009);
  const rateLimitSeconds = Number(env.OWNTRACKS_RATE_LIMIT_SECONDS || 5);
  const allowRequest = createRateLimiter(rateLimitSeconds * 1000);

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/owntracks/pub') {
      handleOwnTracksPub(req, res, logger, allowRequest).catch((err) => {
        logger.error({ err }, 'OwnTracks endpoint error');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('[]');
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  });

  server.listen(port, () => {
    logger.info({ port }, 'HTTP server siap (OwnTracks endpoint di /owntracks/pub)');
  });

  return {
    stop() {
      server.close();
    },
  };
}
