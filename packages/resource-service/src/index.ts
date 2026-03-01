import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connect } from 'amqplib';
import type { Channel } from 'amqplib';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../generated/prisma/index.js';

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
const PORT = process.env.PORT || 3002;
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
const AUDIT_QUEUE = process.env.AUDIT_EVENTS_QUEUE || 'audit_events';
const SERVICE_NAME = 'resource-service';

app.use(cors());
app.use(express.json());

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

// POST /api/v1/resources - Create short URL
app.post('/api/v1/resources', async (req, res) => {
  try {
    const { ownerId, originalUrl } = req.body;
    const shortCode = Math.random().toString(36).substring(2, 8); 
    
    const resource = await prisma.resource.create({
      data: {
        ownerId,
        originalUrl,
        shortCode
      }
    });

    publishAuditEvent({
      type: 'RESOURCE_CREATED',
      actorId: ownerId ?? null,
      service: SERVICE_NAME,
      payload: {
        resourceId: resource.id,
        shortCode: resource.shortCode,
        originalUrl: resource.originalUrl,
      },
      timestamp: new Date().toISOString(),
    });
    
    res.json({
      id: resource.id,
      shortCode: resource.shortCode,
      originalUrl: resource.originalUrl
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create resource' });
  }
});

// GET /api/v1/resources/:id - Fetch details
app.get('/api/v1/resources/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const resource = await prisma.resource.findUnique({
      where: { id }
    });
    
    if (!resource) {
      return res.status(404).json({ error: 'Resource not found' });
    }
    
    res.json(resource);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch resource' });
  }
});

// GET /api/v1/resources/:shortCode/redirect - Get original URL
app.get('/api/v1/resources/:shortCode/redirect', async (req, res) => {
  try {
    const { shortCode } = req.params;
    const resource = await prisma.resource.findUnique({
      where: { shortCode }
    });
    
    if (!resource) {
      return res.status(404).json({ error: 'Short code not found' });
    }
    
    res.json({ originalUrl: resource.originalUrl });
  } catch (error) {
    res.status(500).json({ error: 'Failed to resolve short code' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'resource' }));

app.listen(PORT, () => {
  console.log(`Resource service on port ${PORT}`);
  void initAuditPublisher();
});
