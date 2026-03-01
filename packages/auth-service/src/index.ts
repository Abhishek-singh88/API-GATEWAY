import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { connect } from 'amqplib';
import type { Channel } from 'amqplib';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();
const app = express();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

const databaseUrl = new URL(connectionString);
const schema = databaseUrl.searchParams.get('schema') ?? 'public';
databaseUrl.searchParams.delete('schema');
const pool = new Pool({
  connectionString: databaseUrl.toString(),
  options: `-c search_path=${schema}`,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const PORT = process.env.PORT || 3001;
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
const AUDIT_QUEUE = process.env.AUDIT_EVENTS_QUEUE || 'audit_events';
const SERVICE_NAME = 'auth-service';

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET as string;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET as string;
let auditChannel: Channel | null = null;

type AuditEvent = {
  type: string;
  actorId: string | null;
  service: string;
  payload: Record<string, unknown>;
  timestamp: string;
};

async function initAuditPublisher() {
  try {
    const connection = await connect(RABBITMQ_URL);
    connection.on('error', (error: unknown) => {
      console.error('RabbitMQ connection error:', error);
      auditChannel = null;
    });
    connection.on('close', () => {
      auditChannel = null;
    });

    auditChannel = await connection.createChannel();
    await auditChannel.assertQueue(AUDIT_QUEUE, { durable: true });
    console.log(`Audit publisher ready on queue "${AUDIT_QUEUE}"`);
  } catch (error) {
    console.error('Failed to initialize audit publisher:', error);
  }
}

function publishAuditEvent(event: AuditEvent) {
  if (!auditChannel) {
    return;
  }

  auditChannel.sendToQueue(
    AUDIT_QUEUE,
    Buffer.from(JSON.stringify(event)),
    { persistent: true }
  );
}

// POST /api/v1/auth/register
app.post('/api/v1/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: { email, passwordHash }
    });

    publishAuditEvent({
      type: 'USER_REGISTERED',
      actorId: user.id,
      service: SERVICE_NAME,
      payload: { email: user.email },
      timestamp: new Date().toISOString(),
    });

    res.json({ message: 'User created', userId: user.id });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return res.status(409).json({ error: 'Email exists' });
      }

      if (error.code === 'P2021') {
        return res.status(500).json({ error: 'User table is missing. Run auth-service Prisma migration.' });
      }
    }

    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/v1/auth/login
app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !await bcrypt.compare(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, roles: [user.role] },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    const refreshToken = jwt.sign(
      { userId: user.id },
      REFRESH_SECRET,
      { expiresIn: '7d' }
    );

    publishAuditEvent({
      type: 'USER_LOGGED_IN',
      actorId: user.id,
      service: SERVICE_NAME,
      payload: { email: user.email },
      timestamp: new Date().toISOString(),
    });

    res.json({ token, refreshToken });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/v1/auth/refresh
app.post('/api/v1/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'refreshToken is required' });
    }

    const decoded = jwt.verify(refreshToken, REFRESH_SECRET) as { userId?: string };
    if (!decoded.userId) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, roles: [user.role] },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    const newRefreshToken = jwt.sign(
      { userId: user.id },
      REFRESH_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, refreshToken: newRefreshToken });
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

app.listen(PORT, () => {
  console.log(`Auth service on port ${PORT} (schema=${schema})`);
  void initAuditPublisher();
});
