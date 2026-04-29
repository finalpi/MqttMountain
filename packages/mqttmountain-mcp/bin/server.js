#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DATE_KEY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.db$/;
const MAX_LIMIT = 5000;
const PACKAGE_VERSION = '0.1.0';

function printHelp() {
  process.stdout.write(`mqttmountain-mcp ${PACKAGE_VERSION}

Usage:
  mqttmountain-mcp [--user-data-dir <dir>] [--log-dir <dir>]

Options:
  --user-data-dir <dir>  MQTTMountain app data directory.
  --log-dir <dir>        MQTTMountain message_logs directory.
  --help                 Show this help.

Environment:
  MQTTMOUNTAIN_USER_DATA_DIR
  MQTTMOUNTAIN_LOG_DIR
`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--user-data-dir') out.userDataDir = argv[++i];
    else if (arg === '--log-dir') out.logDir = argv[++i];
    else if (arg.startsWith('--user-data-dir=')) out.userDataDir = arg.slice('--user-data-dir='.length);
    else if (arg.startsWith('--log-dir=')) out.logDir = arg.slice('--log-dir='.length);
  }
  return out;
}

function defaultUserDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'MQTTMountain');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'MQTTMountain');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'MQTTMountain');
}

function configDbPath(userDataDir) {
  return path.join(userDataDir, 'mqtt_mountain.db');
}

function readConfigValue(userDataDir, key) {
  const dbFile = configDbPath(userDataDir);
  if (!fs.existsSync(dbFile)) return null;
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
    if (!row || typeof row.value !== 'string') return null;
    return JSON.parse(row.value);
  } finally {
    db.close();
  }
}

function resolveLogDir(args) {
  if (args.logDir) return path.resolve(args.logDir);
  if (process.env.MQTTMOUNTAIN_LOG_DIR) return path.resolve(process.env.MQTTMOUNTAIN_LOG_DIR);
  const userDataDir = path.resolve(args.userDataDir || process.env.MQTTMOUNTAIN_USER_DATA_DIR || defaultUserDataDir());
  try {
    const settings = readConfigValue(userDataDir, 'settings');
    if (settings && typeof settings.logDir === 'string' && settings.logDir.trim()) {
      return path.resolve(settings.logDir.trim());
    }
  } catch {
    // Fall back to the default app data layout when settings cannot be read.
  }
  return path.join(userDataDir, 'message_logs');
}

function sanitizeConnectionId(id) {
  if (!id) return '_none';
  const safe = String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe.length > 120 ? safe.slice(0, 120) : safe || '_empty';
}

function dayStartTsFromKey(dayKey) {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
}

function dayEndTsFromKey(dayKey) {
  return dayStartTsFromKey(dayKey) + 86_400_000 - 1;
}

function decodeBucket(blob, bucketSec, topic, connectionId) {
  const out = [];
  if (!Buffer.isBuffer(blob) || blob.length < 4) return out;
  const base = bucketSec * 1000;
  const count = blob.readUInt32LE(0);
  let cursor = 4;
  for (let i = 0; i < count && cursor + 6 <= blob.length; i++) {
    const offset = blob.readUInt16LE(cursor);
    cursor += 2;
    const length = blob.readUInt32LE(cursor);
    cursor += 4;
    if (cursor + length > blob.length) break;
    const payload = blob.subarray(cursor, cursor + length).toString('utf8');
    cursor += length;
    out.push({ connectionId, topic, payload, time: base + offset });
  }
  return out;
}

function listLogConnectionIds(logDir) {
  if (!fs.existsSync(logDir)) return [];
  return fs.readdirSync(logDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function listDayFiles(logDir, connectionId, descending = true) {
  const dir = path.join(logDir, sanitizeConnectionId(connectionId));
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((file) => DATE_KEY_FILE_RE.test(file))
    .sort();
  if (descending) files.reverse();
  return files.map((file) => path.join(dir, file));
}

function readConnections(userDataDir, logDir) {
  let saved = [];
  try {
    const config = readConfigValue(userDataDir, 'connections');
    if (config && Array.isArray(config.connections)) {
      saved = config.connections.map((item) => ({
        id: String(item.id || ''),
        name: String(item.name || item.id || ''),
        host: String(item.host || ''),
        port: Number(item.port || 0),
        protocol: String(item.protocol || '')
      })).filter((item) => item.id);
    }
  } catch {
    saved = [];
  }

  const logIds = new Set(listLogConnectionIds(logDir));
  return {
    userDataDir,
    logDir,
    connections: saved.map((item) => ({
      ...item,
      hasLogs: logIds.has(sanitizeConnectionId(item.id))
    })),
    logOnlyConnectionIds: [...logIds].filter((id) => !saved.some((item) => sanitizeConnectionId(item.id) === id))
  };
}

function readRecentMessages(logDir, connectionId, limit) {
  const max = Math.min(MAX_LIMIT, Math.max(1, limit));
  const out = [];
  for (const filePath of listDayFiles(logDir, connectionId, true)) {
    if (out.length >= max) break;
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare('SELECT bucket_ts, topic, blob FROM buckets ORDER BY bucket_ts DESC').all();
      for (const row of rows) {
        const decoded = decodeBucket(row.blob, row.bucket_ts, row.topic, connectionId);
        for (let i = decoded.length - 1; i >= 0; i--) {
          out.push(decoded[i]);
          if (out.length >= max) break;
        }
        if (out.length >= max) break;
      }
    } finally {
      db.close();
    }
  }
  return out;
}

function normalizeKeyword(value) {
  return String(value || '').replace(/\s+/gu, '').toLowerCase();
}

function queryHistory(logDir, options) {
  const startTime = options.startTime && options.startTime > 0 ? options.startTime : -8640000000000000;
  const endTime = options.endTime && options.endTime > 0 ? options.endTime : 8640000000000000;
  const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit || 200));
  const keyword = normalizeKeyword(options.keyword || '');
  const topic = options.topic && options.topic.trim() ? options.topic.trim() : null;
  const connectionIds = options.connectionId
    ? [options.connectionId]
    : listLogConnectionIds(logDir);

  const secMin = Math.floor(Math.max(startTime, -8640000000) / 1000);
  const secMax = Math.ceil(Math.min(endTime, 8640000000000) / 1000);
  const out = [];

  for (const connectionId of connectionIds) {
    const files = listDayFiles(logDir, connectionId, true)
      .filter((filePath) => {
        const dayKey = path.basename(filePath, '.db');
        return dayEndTsFromKey(dayKey) >= startTime && dayStartTsFromKey(dayKey) <= endTime;
      });

    for (const filePath of files) {
      if (out.length >= limit) break;
      const db = new Database(filePath, { readonly: true, fileMustExist: true });
      try {
        let sql = 'SELECT bucket_ts, topic, blob FROM buckets WHERE bucket_ts BETWEEN ? AND ?';
        const params = [secMin, secMax];
        if (topic) {
          sql += ' AND topic = ?';
          params.push(topic);
        }
        sql += ' ORDER BY bucket_ts DESC';
        const rows = db.prepare(sql).all(...params);
        for (const row of rows) {
          const decoded = decodeBucket(row.blob, row.bucket_ts, row.topic, connectionId);
          for (let i = decoded.length - 1; i >= 0; i--) {
            const message = decoded[i];
            if (message.time < startTime || message.time > endTime) continue;
            if (keyword && normalizeKeyword(message.topic + message.payload).indexOf(keyword) < 0) continue;
            out.push(message);
            if (out.length >= limit) break;
          }
          if (out.length >= limit) break;
        }
      } finally {
        db.close();
      }
    }
  }

  out.sort((a, b) => b.time - a.time);
  return out.slice(0, limit);
}

function jsonText(data) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const userDataDir = path.resolve(args.userDataDir || process.env.MQTTMOUNTAIN_USER_DATA_DIR || defaultUserDataDir());
  const logDir = resolveLogDir(args);
  const server = new McpServer({ name: 'mqttmountain-mcp', version: PACKAGE_VERSION });

  server.registerTool(
    'mqttmountain_connections',
    {
      title: 'List MQTTMountain Connections',
      description: 'List saved MQTTMountain connections and log folders available to this MCP server.',
      inputSchema: z.object({})
    },
    async () => jsonText(readConnections(userDataDir, logDir))
  );

  server.registerTool(
    'mqttmountain_recent_messages',
    {
      title: 'Read Recent MQTT Messages',
      description: 'Read recent persisted MQTT messages for a MQTTMountain connection.',
      inputSchema: z.object({
        connectionId: z.string().describe('MQTTMountain connection id. Use mqttmountain_connections first if unsure.'),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(100)
      })
    },
    async ({ connectionId, limit }) => jsonText({
      logDir,
      connectionId,
      messages: readRecentMessages(logDir, connectionId, limit)
    })
  );

  server.registerTool(
    'mqttmountain_query_history',
    {
      title: 'Query MQTT Message History',
      description: 'Query persisted MQTTMountain messages by connection, topic, keyword, and timestamp range.',
      inputSchema: z.object({
        connectionId: z.string().optional().describe('Optional MQTTMountain connection id. Omit to search all log folders.'),
        topic: z.string().optional().describe('Exact MQTT topic filter.'),
        keyword: z.string().optional().describe('Substring search across topic and payload. Whitespace is ignored.'),
        startTime: z.number().optional().describe('Start timestamp in milliseconds since Unix epoch.'),
        endTime: z.number().optional().describe('End timestamp in milliseconds since Unix epoch.'),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(200)
      })
    },
    async (input) => jsonText({
      logDir,
      query: input,
      messages: queryHistory(logDir, input)
    })
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`[mqttmountain-mcp] ${error?.stack || error}\n`);
  process.exit(1);
});
