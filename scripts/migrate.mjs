import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const requireFromApi = createRequire(new URL('../apps/configuration-api/package.json', import.meta.url));
const pg = requireFromApi('pg');

const migrationDirectory = new URL('../db/migrations/', import.meta.url);
const client = new pg.Client({
  host: process.env.POSTGRES_HOST ?? 'db',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  database: process.env.POSTGRES_DB ?? 'event_configuration',
  user: process.env.POSTGRES_USER ?? 'configuration_migrator',
  password: process.env.POSTGRES_PASSWORD,
});

try {
  await client.connect();
  await client.query('SELECT pg_advisory_lock(824201)');
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const filenames = (await readdir(migrationDirectory))
    .filter((name) => /^\d+_[\w-]+\.sql$/.test(name))
    .sort();

  for (const filename of filenames) {
    const sql = await readFile(new URL(filename, migrationDirectory), 'utf8');
    const sha256 = createHash('sha256').update(sql).digest('hex');
    const previous = await client.query(
      'SELECT sha256 FROM schema_migrations WHERE filename = $1',
      [filename],
    );

    if (previous.rowCount) {
      if (previous.rows[0].sha256 !== sha256) {
        throw new Error(`La migración aplicada cambió: ${filename}`);
      }
      console.log(`Ya aplicada: ${filename}`);
      continue;
    }

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)',
        [filename, sha256],
      );
      await client.query('COMMIT');
      console.log(`Aplicada: ${filename}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  const appUser = process.env.APP_DB_USER ?? 'configuration_app';
  const appPassword = process.env.APP_DB_PASSWORD;
  const databaseName = process.env.POSTGRES_DB ?? 'event_configuration';
  if (!/^[a-z_][a-z0-9_]*$/.test(appUser) || !appPassword || appUser === (process.env.POSTGRES_USER ?? 'configuration_migrator')) {
    throw new Error('APP_DB_USER or APP_DB_PASSWORD is invalid.');
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(databaseName)) {
    throw new Error('POSTGRES_DB is invalid.');
  }
  const role = `"${appUser}"`;
  const password = `'${appPassword.replace(/'/g, "''")}'`;
  const roleExists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appUser]);
  if (!roleExists.rowCount) {
    await client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${password}`);
  } else {
    await client.query(`ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${password}`);
  }
  await client.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${role}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${role}`);
  const tableGrants = [
    ['events', 'SELECT, INSERT, UPDATE'],
    ['event_revisions', 'SELECT, INSERT'],
    ['assignments', 'SELECT, INSERT, UPDATE'],
    ['releases', 'SELECT, INSERT'],
    ['release_artifacts', 'SELECT, INSERT'],
    ['release_consumers', 'SELECT'],
    ['audit', 'SELECT, INSERT'],
    ['outbox', 'SELECT, INSERT, UPDATE'],
    ['idempotency_records', 'SELECT, INSERT'],
  ];
  for (const [table, permissions] of tableGrants) {
    await client.query(`GRANT ${permissions} ON TABLE ${table} TO ${role}`);
  }
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
} catch (error) {
  console.error('Falló la migración:', error);
  process.exitCode = 1;
} finally {
  await client.end();
}
