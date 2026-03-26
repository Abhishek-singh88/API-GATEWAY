import { createHash } from 'crypto';
import dotenv from 'dotenv';
import { connect } from 'amqplib';
import type { Channel, ConsumeMessage } from 'amqplib';
import { ethers } from 'ethers';
import { Pool } from 'pg';
import http from 'http';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
const AUDIT_QUEUE = process.env.AUDIT_EVENTS_QUEUE || 'audit_events';
const CHAIN_RPC_URL = process.env.CHAIN_RPC_URL || '';
const CHAIN_PRIVATE_KEY = process.env.CHAIN_PRIVATE_KEY || '';
const AUDIT_CONTRACT_ADDRESS = process.env.AUDIT_CONTRACT_ADDRESS || '';
const HEALTH_PORT = Number(process.env.PORT || 3004);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${schema.replace(/"/g, '""')}"."AuditChainJob" (
      id TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT,
      tx_hash TEXT,
      next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS auditchainjob_next_run_idx
    ON "${schema.replace(/"/g, '""')}"."AuditChainJob" (status, next_run_at)
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

  await pool.query(
    `
      INSERT INTO "${schema.replace(/"/g, '""')}"."AuditChainJob" (id, hash, status)
      VALUES ($1, $2, 'pending')
      ON CONFLICT (id) DO NOTHING
    `,
    [id, hash]
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

  let chainClient: ethers.Contract | null = null;
  if (CHAIN_RPC_URL && CHAIN_PRIVATE_KEY && AUDIT_CONTRACT_ADDRESS) {
    const provider = new ethers.JsonRpcProvider(CHAIN_RPC_URL);
    const wallet = new ethers.Wallet(CHAIN_PRIVATE_KEY, provider);
    const abi = [
      'function storeHash(bytes32 hash) external',
      'event HashStored(bytes32 indexed hash, address indexed sender)',
    ];
    chainClient = new ethers.Contract(AUDIT_CONTRACT_ADDRESS, abi, wallet);
    console.log(`Audit chain worker enabled (contract=${AUDIT_CONTRACT_ADDRESS})`);
  } else {
    console.log('Audit chain worker disabled (missing CHAIN_RPC_URL/CHAIN_PRIVATE_KEY/AUDIT_CONTRACT_ADDRESS)');
  }

  let workerRunning = false;
  const runWorker = async () => {
    if (workerRunning || !chainClient) {
      return;
    }
    workerRunning = true;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `
          SELECT id, hash, attempts
          FROM "${schema.replace(/"/g, '""')}"."AuditChainJob"
          WHERE status = 'pending' AND next_run_at <= NOW()
          ORDER BY created_at ASC
          LIMIT 5
          FOR UPDATE SKIP LOCKED
        `
      );

      for (const row of result.rows) {
        const id = row.id as string;
        const hash = row.hash as string;
        const attempts = Number(row.attempts ?? 0);
        const bytes32 = hash.startsWith('0x') ? hash : `0x${hash}`;

        try {
          const tx = await chainClient.storeHash(bytes32);
          const receipt = await tx.wait(1);
          await client.query(
            `
              UPDATE "${schema.replace(/"/g, '""')}"."AuditChainJob"
              SET status = 'confirmed', tx_hash = $2, updated_at = NOW()
              WHERE id = $1
            `,
            [id, receipt?.hash ?? tx.hash]
          );
        } catch (error) {
          const nextAttempts = attempts + 1;
          const delaySec = Math.min(60 * nextAttempts, 300);
          const status = nextAttempts >= 5 ? 'failed' : 'pending';
          await client.query(
            `
              UPDATE "${schema.replace(/"/g, '""')}"."AuditChainJob"
              SET status = $2,
                  attempts = $3,
                  last_error = $4,
                  next_run_at = NOW() + ($5 || ' seconds')::interval,
                  updated_at = NOW()
              WHERE id = $1
            `,
            [id, status, nextAttempts, String(error), String(delaySec)]
          );
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Audit chain worker error:', error);
    } finally {
      client.release();
      workerRunning = false;
    }
  };

  setInterval(runWorker, 10_000);

  const healthServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'audit' }));
  });
  healthServer.listen(HEALTH_PORT, () => {
    console.log(`Audit health endpoint listening on port ${HEALTH_PORT}`);
  });

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
