import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';

const requireFromWorker = createRequire(new URL('../package.json', import.meta.url));
const { Pool } = requireFromWorker('pg');

const config = {
  tenants: (process.env.WORKER_TENANT_IDS || '')
    .split(',').map((id) => id.trim()).filter(Boolean),
  pollMs: Number(process.env.WORKER_POLL_INTERVAL_MS || 1000),
  batchSize: Number(process.env.WORKER_BATCH_SIZE || 10),
  leaseSeconds: Number(process.env.WORKER_LEASE_SECONDS || 60),
  maxBackoffSeconds: Number(process.env.WORKER_MAX_BACKOFF_SECONDS || 300),
  failFirstN: Number(process.env.SIMULATOR_FAIL_FIRST_N || 0),
  failEveryN: Number(process.env.SIMULATOR_FAIL_EVERY_N || 0),
};

if (!config.tenants.length) throw new Error('WORKER_TENANT_IDS must list authorized tenant UUIDs.');
for (const tenant of config.tenants) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant)) {
    throw new Error(`Invalid tenant UUID in WORKER_TENANT_IDS: ${tenant}`);
  }
}

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'db',
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || 'event_configuration',
  user: process.env.POSTGRES_USER || 'configuration_app',
  password: process.env.POSTGRES_PASSWORD,
  max: 5,
  connectionTimeoutMillis: 5000,
});

class SimulatedBroker {
  #attempts = 0;
  async publish(row) {
    this.#attempts += 1;
    if (this.#attempts <= config.failFirstN || (config.failEveryN > 0 && this.#attempts % config.failEveryN === 0)) {
      throw Object.assign(new Error('SIMULATOR_TRANSIENT_FAILURE'), { transient: true });
    }
    console.log(JSON.stringify({
      level: 'info', event: 'simulated_broker_publish',
      outbox_id: row.id, domain_event_id: row.payload?.domain_event_id,
      topic: row.payload?.topic || row.event_type,
      partition_key: row.payload?.partition_key || `${row.organization_id}:${row.aggregate_id}`,
      simulated_attempt: this.#attempts,
    }));
    return { accepted: true, broker_message_id: randomUUID() };
  }
}

const broker = new SimulatedBroker();
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

async function claimBatch(tenantId, workerId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_organization_id', $1, true)", [tenantId]);
    const selected = await client.query(`
      SELECT id
      FROM outbox
      WHERE organization_id = $1
        AND status = 'pending'
        AND next_retry_at <= clock_timestamp()
        AND (locked_until IS NULL OR locked_until < clock_timestamp())
      ORDER BY next_retry_at, created_at, id
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    `, [tenantId, config.batchSize]);
    if (!selected.rowCount) {
      await client.query('COMMIT');
      return [];
    }
    const ids = selected.rows.map((row) => row.id);
    const claimed = await client.query(`
      UPDATE outbox
      SET locked_by = $2, locked_until = clock_timestamp() + ($3 * interval '1 second')
      WHERE organization_id = $1 AND id = ANY($4::uuid[])
      RETURNING id, organization_id, event_type, aggregate_id, payload, headers, retry_count, max_retries
    `, [tenantId, workerId, config.leaseSeconds, ids]);
    await client.query('COMMIT');
    return claimed.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function complete(row, workerId, confirmation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_organization_id', $1, true)", [row.organization_id]);
    await client.query(`
      UPDATE outbox
      SET status = 'delivered', delivered_at = clock_timestamp(), last_error = NULL,
          locked_by = NULL, locked_until = NULL
      WHERE organization_id = $1 AND id = $2 AND locked_by = $3
    `, [row.organization_id, row.id, workerId]);
    await client.query('COMMIT');
    console.log(JSON.stringify({ level: 'info', event: 'outbox_delivered', outbox_id: row.id, broker_confirmation: confirmation.accepted }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function fail(row, workerId, error) {
  const attempts = row.retry_count + 1;
  const terminal = attempts >= row.max_retries;
  const exponential = Math.min(config.maxBackoffSeconds, 2 ** Math.min(attempts, 16));
  const jittered = Math.max(1, Math.round(exponential * (0.75 + Math.random() * 0.5)));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_organization_id', $1, true)", [row.organization_id]);
    await client.query(`
      UPDATE outbox
      SET retry_count = $4, status = $5::varchar,
          next_retry_at = CASE WHEN $5::varchar = 'pending' THEN clock_timestamp() + ($6 * interval '1 second') ELSE next_retry_at END,
          last_error = $7, locked_by = NULL, locked_until = NULL
      WHERE organization_id = $1 AND id = $2 AND locked_by = $3
    `, [row.organization_id, row.id, workerId, attempts, terminal ? 'failed' : 'pending', jittered, String(error.message || 'BROKER_FAILURE').slice(0, 500)]);
    await client.query('COMMIT');
    console.log(JSON.stringify({ level: terminal ? 'error' : 'warn', event: terminal ? 'outbox_failed' : 'outbox_retry_scheduled', outbox_id: row.id, attempts, retry_in_seconds: terminal ? null : jittered, error: String(error.message || 'BROKER_FAILURE').slice(0, 200) }));
  } catch (updateError) {
    await client.query('ROLLBACK');
    throw updateError;
  } finally { client.release(); }
}

async function run() {
  const workerId = `${process.env.HOSTNAME || 'configuration-worker'}:${process.pid}:${randomUUID()}`;
  console.log(JSON.stringify({ level: 'info', event: 'worker_started', worker_id: workerId, tenants: config.tenants.length, broker: 'simulator' }));
  while (!stopping) {
    let found = false;
    for (const tenant of config.tenants) {
      if (stopping) break;
      const batch = await claimBatch(tenant, workerId);
      found ||= batch.length > 0;
      for (const row of batch) {
        if (stopping) break;
        try {
          const confirmation = await broker.publish(row);
          await complete(row, workerId, confirmation);
        } catch (error) {
          await fail(row, workerId, error);
        }
      }
    }
    if (!found) await delay(config.pollMs);
  }
  await pool.end();
  console.log(JSON.stringify({ level: 'info', event: 'worker_stopped' }));
}

run().catch(async (error) => {
  console.error(JSON.stringify({ level: 'fatal', event: 'worker_crashed', error: error.message }));
  await pool.end();
  process.exitCode = 1;
});
