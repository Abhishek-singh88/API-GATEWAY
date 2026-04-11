# API Gateway Microservices – Audit & Chain Verification

End‑to‑end microservices project with an API gateway, event bus, off‑chain audit logging, and on‑chain hash verification (Sepolia). Built for demonstrable “tamper‑proof” audit trails.

## Architecture

- **Gateway (port 3000)**: central entry point, JWT auth, rate limits, validation, logging, audit verify endpoint
- **Auth Service (port 3001)**: user register/login/refresh, emits audit events
- **Resource Service (port 3002)**: URL shortener resources, emits audit events
- **Audit Service (port 3004 health)**: consumes events, stores audit log, queues chain writes, pushes hashes on‑chain
- **Infra**: Postgres, RabbitMQ, Redis

Event flow:

1. Auth/Resource emits event → RabbitMQ `audit_events`
2. Audit service consumes, hashes, stores in Postgres
3. Audit service queues hash for chain worker
4. Chain worker submits `storeHash(bytes32)` to Sepolia
5. Gateway `/api/v1/audit/:id/verify` recomputes hash and confirms on‑chain

## Services & Ports

- Gateway: `http://localhost:3000`
- Auth: `http://localhost:3001`
- Resource: `http://localhost:3002`
- Audit health: `http://localhost:3004/health`

## Tech Stack

- Node.js + TypeScript
- Express
- Prisma + PostgreSQL
- RabbitMQ (event bus)
- Redis (rate limiting)
- Ethers v6 (Sepolia chain writes + verification)
- Hardhat (contract deployment)
- Zod (request validation)

## Local Setup

### 1) Install dependencies

```bash
cd ~/Desktop/Collage_project/api-gateway
npm install
```

### 2) Start infra (Postgres, RabbitMQ, Redis)

```bash
npm run db:start
```

### 3) Configure env files

Each service has its own `.env`. Update values as needed.

**Gateway** – `packages/gateway-service/.env`
```
PORT=3000
AUTH_SERVICE_URL="http://localhost:3001"
RESOURCE_SERVICE_URL="http://localhost:3002"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="supersecretkeychangeme"
AUDIT_DATABASE_URL="postgresql://user:pass@localhost:5432/api_gateway?schema=audit"
CHAIN_RPC_URL="https://rpc.sepolia.org"
AUDIT_CONTRACT_ADDRESS="0x..."
```

**Auth** – `packages/auth-service/.env`
```
PORT=3001
DATABASE_URL="postgresql://user:pass@localhost:5432/api_gateway?schema=public"
JWT_SECRET=supersecretkeychangeme
JWT_REFRESH_SECRET=superrefreshsecretchangeme
RABBITMQ_URL="amqp://guest:guest@localhost:5672"
AUDIT_EVENTS_QUEUE="audit_events"
```

**Resource** – `packages/resource-service/.env`
```
PORT=3002
DATABASE_URL="postgresql://user:pass@localhost:5432/api_gateway?schema=public"
RABBITMQ_URL="amqp://guest:guest@localhost:5672"
AUDIT_EVENTS_QUEUE="audit_events"
```

**Audit** – `packages/audit-service/.env`
```
DATABASE_URL="postgresql://user:pass@localhost:5432/api_gateway?schema=audit"
RABBITMQ_URL="amqp://guest:guest@localhost:5672"
AUDIT_EVENTS_QUEUE="audit_events"
CHAIN_RPC_URL="https://rpc.sepolia.org"
CHAIN_PRIVATE_KEY="YOUR_PRIVATE_KEY"
AUDIT_CONTRACT_ADDRESS="0x..."
PORT=3004
```

### 4) Start services

```bash
cd packages/auth-service && npm run dev
cd packages/resource-service && npm run dev
cd packages/audit-service && npm run dev
cd packages/gateway-service && npm run dev
```

## Smart Contract (Sepolia)

Contract lives in `packages/audit-contract`.

### Deploy

```bash
cd packages/audit-contract
npm install
cp .env.example .env  # or edit .env directly
npm run compile
npm run deploy:sepolia
```

Set the deployed contract address into:
- `packages/audit-service/.env` → `AUDIT_CONTRACT_ADDRESS`
- `packages/gateway-service/.env` → `AUDIT_CONTRACT_ADDRESS`

## API Endpoints (Gateway)

### Auth
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`

### Resource (protected)
- `POST /api/v1/resources`
- `GET /api/v1/resources/:id`
- `GET /api/v1/resources/:shortCode/redirect`

### Audit verification
- `GET /api/v1/audit/:id/verify`

### Health checks
- `GET /health` (gateway)
- `GET /health` (auth)
- `GET /health` (resource)
- `GET http://localhost:3004/health` (audit)

## Example Postman Flow

1. **Register** → `POST /api/v1/auth/register`
2. **Login** → `POST /api/v1/auth/login` → copy `token`
3. **Create Resource** → `POST /api/v1/resources` with `Authorization: Bearer <token>`
4. **Verify Audit**:
   - Query audit DB for latest id:
     ```bash
     docker exec -it infra-postgres-1 psql -U user -d api_gateway -c 'SELECT id FROM audit."AuditLog" ORDER BY created_at DESC LIMIT 1;'
     ```
   - Call:
     ```
     GET /api/v1/audit/<id>/verify
     ```

Expected `verify` response:
```json
{
  "id": "...",
  "valid": true,
  "details": {
    "dbHash": "...",
    "recomputedHash": "...",
    "onChainStored": true,
    "contract": "0x..."
  }
}
```

## Troubleshooting

- **Gateway `ECONNREFUSED`**: target service isn’t running.
- **Audit chain worker disabled**: missing chain env vars.
- **Verify endpoint `TIMEOUT`**: RPC URL down; switch to Infura/Alchemy.
- **Resource 500**: check resource‑service logs for DB constraint errors.

## Project Status

- Phase 1: Auth + Resource services complete
- Phase 2: Event bus + audit logging complete
- Phase 3: Gateway (auth, rate limit, validation, logging) complete
- Phase 4: On‑chain hash storage complete
- Phase 5: Verification endpoint + health checks complete
