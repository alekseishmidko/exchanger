#!/usr/bin/env node
import { createServer } from 'node:http';
import {
  ExchangeSimulationWorker,
  normalizeSimulationConfig,
} from './exchange-simulation-engine.mjs';

const serverMode = process.argv.includes('--server');
const backendUrl = process.env['SIMULATION_BACKEND_URL'] ?? 'http://127.0.0.1:5001';
const adminApiKey = process.env['SIMULATION_ADMIN_API_KEY'] ?? 'dev-admin-key';
const worker = new ExchangeSimulationWorker({ backendUrl, adminApiKey });

if (serverMode) {
  startControlServer();
} else {
  startCli();
}

function startControlServer() {
  const port = Number(process.env['SIMULATION_CONTROL_PORT'] ?? 5055);
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/simulation/health') {
        return json(response, 200, { status: 'ok' });
      }
      if (request.method === 'GET' && request.url === '/simulation/status') {
        return json(response, 200, worker.status());
      }
      if (request.method === 'POST' && request.url === '/simulation/start') {
        const config = normalizeSimulationConfig(await readJson(request));
        return json(response, 202, worker.start(config));
      }
      if (request.method === 'POST' && request.url === '/simulation/stop') {
        return json(response, 202, worker.stop());
      }
      return json(response, 404, { code: 'NOT_FOUND', message: 'Simulation route not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown simulation error';
      return json(response, message.includes('already running') ? 409 : 400, {
        code: 'SIMULATION_REQUEST_FAILED',
        message,
      });
    }
  });
  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(
      `Exchange simulation control server: http://0.0.0.0:${port}/simulation/status\n`,
    );
  });
  const shutdown = () => {
    worker.stop();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function startCli() {
  const config = normalizeSimulationConfig({
    users: process.env['SIMULATION_USERS'],
    seed: process.env['SIMULATION_SEED'],
    ordersPerRound: process.env['SIMULATION_ORDERS_PER_ROUND'],
    intervalMs: process.env['SIMULATION_INTERVAL_MS'],
    setupConcurrency: process.env['SIMULATION_SETUP_CONCURRENCY'],
    orderConcurrency: process.env['SIMULATION_ORDER_CONCURRENCY'],
  });
  worker.start(config);
  process.stdout.write(
    `Starting exchange simulation with ${config.users} users (seed ${config.seed}).\n`,
  );
  const reporter = setInterval(() => {
    const status = worker.status();
    process.stdout.write(
      `[${status.phase}] users=${status.usersReady}/${status.usersTotal} markets=${status.marketsReady} orders=${status.ordersAccepted}/${status.ordersSubmitted} filled=${status.ordersFilled} rejected=${status.ordersRejected}\n`,
    );
  }, 5_000);
  const shutdown = () => worker.stop();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const finish = setInterval(() => {
    const status = worker.status();
    if (!status.running) {
      clearInterval(reporter);
      clearInterval(finish);
      process.exitCode = status.phase === 'failed' ? 1 : 0;
    }
  }, 250);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}
