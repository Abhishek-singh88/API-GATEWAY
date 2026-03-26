import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { Redis } from 'ioredis';
import { createHash } from 'crypto';
import { Pool } from 'pg';
import { ethers } from 'ethers';

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 3000);
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const RESOURCE_SERVICE_URL = process.env.RESOURCE_SERVICE_URL || 'http://localhost:3002';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const JWT_SECRET = process.env.JWT_SECRET || 'changeme';
const AUDIT_DATABASE_URL = process.env.AUDIT_DATABASE_URL || '';
const CHAIN_RPC_URL = process.env.CHAIN_RPC_URL || '';
const AUDIT_CONTRACT_ADDRESS = process.env.AUDIT_CONTRACT_ADDRESS || '';

const redis = new Redis(REDIS_URL);
const auditPool = AUDIT_DATABASE_URL
  ? new Pool({ connectionString: AUDIT_DATABASE_URL })
  : null;

const chainProvider = CHAIN_RPC_URL ? new ethers.JsonRpcProvider(CHAIN_RPC_URL) : null;
const chainContract = (chainProvider && AUDIT_CONTRACT_ADDRESS)
  ? new ethers.Contract(
      AUDIT_CONTRACT_ADDRESS,
      ['function stored(bytes32 hash) view returns (bool)'],
      chainProvider
    )
  : null;

app.use(cors());
app.use(express.json());

type AuthedRequest = express.Request & {
  user?: {
    id: string;
    email?: string;
    roles?: string[];
  };
};

function logRequest(req: AuthedRequest, res: express.Response, startMs: number) {
  const latencyMs = Date.now() - startMs;
  const entry = {
    method: req.method,
    path: req.originalUrl,
    status: res.statusCode,
    latency_ms: latencyMs,
    user_id: req.user?.id ?? null,
  };
  console.log(JSON.stringify(entry));
}

app.use((req: AuthedRequest, res, next) => {
  const startMs = Date.now();
  res.on('finish', () => logRequest(req, res, startMs));
  next();
});

function parseBearerToken(header?: string): string | null {
  if (!header) {
    return null;
  }
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return null;
  }
  return token;
}

function requireAuth(req: AuthedRequest, res: express.Response, next: express.NextFunction) {
  const token = parseBearerToken(req.headers.authorization);
  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId?: string;
      email?: string;
      roles?: string[];
      role?: string;
    };

    if (!decoded.userId) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const roles = decoded.roles ?? (decoded.role ? [decoded.role] : []);
    const user: AuthedRequest['user'] = { id: decoded.userId };
    if (decoded.email) {
      user.email = decoded.email;
    }
    if (roles.length > 0) {
      user.roles = roles;
    }
    req.user = user;

    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function rateLimit(req: AuthedRequest, res: express.Response, next: express.NextFunction) {
  const windowSec = 300; // 5 minutes
  const userLimit = 100;
  const ipLimit = 1000;

  const ip = req.ip || 'unknown';
  const userId = req.user?.id;

  const keys: Array<{ key: string; limit: number; scope: 'user' | 'ip' }> = [];
  keys.push({ key: `ratelimit:ip:${ip}`, limit: ipLimit, scope: 'ip' });
  if (userId) {
    keys.push({ key: `ratelimit:user:${userId}`, limit: userLimit, scope: 'user' });
  }

  const pipeline = redis.multi();
  for (const k of keys) {
    pipeline.incr(k.key);
    pipeline.ttl(k.key);
  }
  const results = await pipeline.exec();

  if (!results) {
    return res.status(500).json({ error: 'Rate limit store unavailable' });
  }

  for (const [i, entry] of keys.entries()) {
    const incrIndex = i * 2;
    const ttlIndex = i * 2 + 1;

    const count = Number(results[incrIndex]?.[1] ?? 0);
    let ttl = Number(results[ttlIndex]?.[1] ?? -1);
    if (ttl < 0) {
      await redis.expire(entry.key, windowSec);
      ttl = windowSec;
    }

    const remaining = Math.max(entry.limit - count, 0);
    res.setHeader('X-RateLimit-Limit', String(entry.limit));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(ttl));
    res.setHeader('X-RateLimit-Scope', entry.scope);

    if (count > entry.limit) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
  }

  return next();
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const resourceCreateSchema = z.object({
  ownerId: z.string().min(1),
  originalUrl: z.string().url(),
});

function validateBody(schema: z.ZodSchema) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    }
    req.body = parsed.data;
    return next();
  };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function buildCanonicalData(input: {
  type: string;
  actorId: string | null;
  service: string;
  payload: Record<string, unknown>;
  timestamp: string;
}): string {
  return JSON.stringify({
    type: input.type,
    actorId: input.actorId,
    service: input.service,
    payload: input.payload,
    timestamp: input.timestamp,
  });
}

async function forwardRequest(targetBase: string, req: express.Request, res: express.Response) {
  const url = new URL(req.originalUrl, targetBase);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) {
      continue;
    }
    if (key.toLowerCase() === 'host') {
      continue;
    }
    if (key.toLowerCase() === 'content-length') {
      continue;
    }
    headers.set(key, Array.isArray(value) ? value.join(',') : value);
  }

  const method = req.method.toUpperCase();
  const init: RequestInit = { method, headers };

  if (method !== 'GET' && method !== 'HEAD') {
    init.body = JSON.stringify(req.body ?? {});
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
  }

  const response = await fetch(url, init);
  const text = await response.text();

  res.status(response.status);
  response.headers.forEach((val, key) => {
    if (key.toLowerCase() === 'transfer-encoding') {
      return;
    }
    res.setHeader(key, val);
  });

  res.send(text);
}

app.get('/api/v1/audit/:id/verify', async (req, res) => {
  if (!auditPool) {
    return res.status(500).json({ error: 'AUDIT_DATABASE_URL not configured' });
  }
  if (!chainContract) {
    return res.status(500).json({ error: 'CHAIN_RPC_URL or AUDIT_CONTRACT_ADDRESS not configured' });
  }

  const id = req.params.id;
  const result = await auditPool.query(
    `
      SELECT id, type, actor_id, service, payload_json, hash, created_at
      FROM "audit"."AuditLog"
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Audit event not found' });
  }

  const row = result.rows[0];
  const canonical = buildCanonicalData({
    type: row.type,
    actorId: row.actor_id,
    service: row.service,
    payload: row.payload_json ?? {},
    timestamp: new Date(row.created_at).toISOString(),
  });

  const recomputedHash = sha256(canonical);
  const dbHash = row.hash;
  const bytes32 = dbHash.startsWith('0x') ? dbHash : `0x${dbHash}`;
  let onChainStored: boolean | null = null;
  try {
    onChainStored = await chainContract.stored(bytes32);
  } catch (error) {
    return res.status(502).json({
      error: 'Failed to reach blockchain RPC',
      details: {
        message: String(error),
        rpc: CHAIN_RPC_URL,
      },
    });
  }

  const valid = (recomputedHash === dbHash) && Boolean(onChainStored);

  return res.json({
    id: row.id,
    valid,
    details: {
      dbHash,
      recomputedHash,
      onChainStored,
      contract: AUDIT_CONTRACT_ADDRESS,
    }
  });
});

// Auth routes (no auth required)
app.post('/api/v1/auth/register', rateLimit, validateBody(registerSchema), (req, res) => {
  void forwardRequest(AUTH_SERVICE_URL, req, res);
});

app.post('/api/v1/auth/login', rateLimit, validateBody(loginSchema), (req, res) => {
  void forwardRequest(AUTH_SERVICE_URL, req, res);
});

app.post('/api/v1/auth/refresh', rateLimit, validateBody(refreshSchema), (req, res) => {
  void forwardRequest(AUTH_SERVICE_URL, req, res);
});

// Resource routes (auth required)
app.post('/api/v1/resources', requireAuth, rateLimit, validateBody(resourceCreateSchema), (req, res) => {
  void forwardRequest(RESOURCE_SERVICE_URL, req, res);
});

app.get('/api/v1/resources/:id', requireAuth, rateLimit, (req, res) => {
  void forwardRequest(RESOURCE_SERVICE_URL, req, res);
});

app.get('/api/v1/resources/:shortCode/redirect', requireAuth, rateLimit, (req, res) => {
  void forwardRequest(RESOURCE_SERVICE_URL, req, res);
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'gateway' }));

app.listen(PORT, () => {
  console.log(`Gateway service on port ${PORT}`);
});
