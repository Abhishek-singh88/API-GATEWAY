import { createHash } from 'crypto';
import dotenv from 'dotenv';
import { connect } from 'amqplib';
import type { Channel, ConsumeMessage } from 'amqplib';
import { Pool } from 'pg';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
const AUDIT_QUEUE = process.env.AUDIT_EVENTS_QUEUE || 'audit_events';

const databaseUrl = new URL(connectionString);
const schema = databaseUrl.searchParams.get('schema') ?? 'public';
databaseUrl.searchParams.delete('schema');
const pool = new Pool({
  connectionString: databaseUrl.toString(),
  options: `-c search_path=${schema}`,
});

type AuditEvent = {
  type: string;
  actorId: string | null;
  service: string;
  payload: Record<string, unknown>;
  timestamp: string;
};

function normalizeEvent(input: unknown): AuditEvent {
  const raw = (typeof input === 'object' && input !== null) ? input as Record<string, unknown> : {};

  const type = typeof raw.type === 'string' ? raw.type : 'UNKNOWN';
  const actorId = typeof raw.actorId === 'string' ? raw.actorId : null;
  const service = typeof raw.service === 'string' ? raw.service : 'unknown-service';
  const payload = (typeof raw.payload === 'object' && raw.payload !== null) ? raw.payload as Record<string, unknown> : {};
  const timestamp = typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString();

  return { type, actorId, service, payload, timestamp };
}

async function ensureTable() {
  // Create schema explicitly so first boot works even on a fresh database.
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema.replace(/"/g, '""')}"`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${schema.replace(/"/g, '""')}"."AuditLog" (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      actor_id TEXT,
      service TEXT NOT NULL,
      payload_json JSONB NOT NULL,
      hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS auditlog_created_at_idx
    ON "${schema.replace(/"/g, '""')}"."AuditLog" (created_at DESC)
  `);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function buildCanonicalData(event: AuditEvent): string {
  return JSON.stringify({
    type: event.type,
    actorId: event.actorId,
    service: event.service,
    payload: event.payload,
    timestamp: event.timestamp,
  });
}

async function saveEvent(event: AuditEvent) {
  const eventData = buildCanonicalData(event);
  const hash = sha256(eventData);
  const id = hash;

  await pool.query(
    `
      INSERT INTO "${schema.replace(/"/g, '""')}"."AuditLog" (id, type, actor_id, service, payload_json, hash, created_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz)
      ON CONFLICT (id) DO NOTHING
    `,
    [
      id,
      event.type,
      event.actorId,
      event.service,
      JSON.stringify(event.payload),
      hash,
      event.timestamp,
    ]
  );
}

async function processMessage(channel: Channel, message: ConsumeMessage | null) {
  if (!message) {
    return;
  }

  try {
    const parsed = JSON.parse(message.content.toString()) as unknown;
    const event = normalizeEvent(parsed);
    await saveEvent(event);
    channel.ack(message);
  } catch (error) {
    console.error('Failed to process audit event:', error);
    channel.nack(message, false, false);
  }
}

async function start() {
  await ensureTable();

  const connection = await connect(RABBITMQ_URL);
  connection.on('error', (error: unknown) => {
    console.error('RabbitMQ connection error:', error);
  });

  const channel = await connection.createChannel();
  await channel.assertQueue(AUDIT_QUEUE, { durable: true });
  await channel.prefetch(20);

  console.log(`Audit service consuming queue "${AUDIT_QUEUE}" (schema=${schema})`);
  await channel.consume(AUDIT_QUEUE, (message: ConsumeMessage | null) => {
    void processMessage(channel, message);
  });
}

start().catch((error) => {
  console.error('Audit service failed to start:', error);
  process.exit(1);
});
