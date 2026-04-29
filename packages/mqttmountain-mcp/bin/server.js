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
const DEFAULT_STATUS_MINUTES = 10;
const DEFAULT_STATUS_TOPIC_LIMIT = 10;
const DEFAULT_PAYLOAD_SAMPLE_LIMIT = 5;
const DEFAULT_PAYLOAD_PREVIEW_CHARS = 300;
const PACKAGE_VERSION = '0.1.2';

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
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return bestExistingDir([
      path.join(base, 'mqttmountain'),
      path.join(base, 'MQTTMountain'),
      path.join(base, 'mqtt-mountain')
    ]);
  }
  if (process.platform === 'darwin') {
    const base = path.join(os.homedir(), 'Library', 'Application Support');
    return bestExistingDir([
      path.join(base, 'mqttmountain'),
      path.join(base, 'MQTTMountain'),
      path.join(base, 'mqtt-mountain')
    ]);
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return bestExistingDir([
    path.join(base, 'mqttmountain'),
    path.join(base, 'MQTTMountain'),
    path.join(base, 'mqtt-mountain')
  ]);
}

function bestExistingDir(candidates) {
  const scored = candidates.map((dir) => ({
    dir,
    score: (fs.existsSync(configDbPath(dir)) ? 2 : 0) + (fs.existsSync(path.join(dir, 'message_logs')) ? 1 : 0)
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score > 0 ? scored[0].dir : candidates[0];
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

function readConnections(userDataDir, logDir, includeMatchFields = false) {
  let saved = [];
  let selectedId = null;
  try {
    const config = readConfigValue(userDataDir, 'connections');
    if (config && Array.isArray(config.connections)) {
      selectedId = typeof config.selectedId === 'string' ? config.selectedId : null;
      saved = config.connections.map((item) => ({
        id: String(item.id || ''),
        name: String(item.name || item.id || ''),
        host: String(item.host || ''),
        port: Number(item.port || 0),
        protocol: String(item.protocol || ''),
        username: String(item.username || ''),
        subscriptionTopics: Array.isArray(item.subscriptions)
          ? item.subscriptions.map((sub) => String(sub.topic || '')).filter(Boolean)
          : []
      })).filter((item) => item.id);
    }
  } catch {
    saved = [];
  }

  const logIds = new Set(listLogConnectionIds(logDir));
  return {
    userDataDir,
    logDir,
    selectedId,
    connections: saved.map((item) => {
      const connection = {
        id: item.id,
        name: item.name,
        host: item.host,
        port: item.port,
        protocol: item.protocol,
        hasLogs: logIds.has(sanitizeConnectionId(item.id))
      };
      return includeMatchFields
        ? { ...connection, username: item.username, subscriptionTopics: item.subscriptionTopics }
        : connection;
    }),
    logOnlyConnectionIds: [...logIds].filter((id) => !saved.some((item) => sanitizeConnectionId(item.id) === id))
  };
}

function resolveConnectionId(userDataDir, logDir, input) {
  if (input.connectionId && input.connectionId.trim()) return input.connectionId.trim();
  const name = input.connectionName && input.connectionName.trim();
  const keyword = input.connectionKeyword && input.connectionKeyword.trim();
  const query = name || keyword;
  if (!query) return null;

  const config = readConnections(userDataDir, logDir, true);
  const matches = config.connections.filter((item) => item.name === query || item.id === query);
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new Error(`Connection "${query}" matched multiple connections. Use connectionId instead.`);
  }

  const fuzzyMatches = config.connections.filter((item) => connectionMatches(item, query));
  if (fuzzyMatches.length === 1) return fuzzyMatches[0].id;
  if (fuzzyMatches.length > 1 && config.selectedId && fuzzyMatches.some((item) => item.id === config.selectedId)) {
    return config.selectedId;
  }
  if (fuzzyMatches.length > 1) {
    throw new Error(`Connection "${query}" matched multiple connections. Use connectionId instead.`);
  }

  const logOnlyMatch = config.logOnlyConnectionIds.find((id) => id === query || sanitizeConnectionId(id) === query);
  if (logOnlyMatch) return logOnlyMatch;
  throw new Error(`Connection not found: ${query}`);
}

function readRecentMessages(logDir, connectionId, limit, topic) {
  const max = Math.min(MAX_LIMIT, Math.max(1, limit));
  const topicFilter = topic && topic.trim() ? topic.trim() : null;
  const out = [];
  for (const filePath of listDayFiles(logDir, connectionId, true)) {
    if (out.length >= max) break;
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
      const rows = topicFilter
        ? db.prepare('SELECT bucket_ts, topic, blob FROM buckets WHERE topic = ? ORDER BY bucket_ts DESC').all(topicFilter)
        : db.prepare('SELECT bucket_ts, topic, blob FROM buckets ORDER BY bucket_ts DESC').all();
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

function connectionMatches(item, query) {
  const terms = expandConnectionSearchTerms(query);
  const hay = normalizeKeyword([
    item.id,
    item.name,
    item.host,
    item.username,
    ...(item.subscriptionTopics || [])
  ].join(' '));
  return terms.some((term) => hay.includes(term));
}

function expandConnectionSearchTerms(value) {
  const normalized = normalizeKeyword(value);
  const terms = [normalized];
  if (normalized.includes('深圳') && normalized.includes('星扬')) {
    terms.push('xingyang-szga', 'xingyangszga', 'szga');
  }
  return [...new Set(terms.filter(Boolean))];
}

function formatLocalTime(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function previewPayload(payload, maxChars) {
  if (!maxChars) return undefined;
  const text = String(payload || '').replace(/\s+/gu, ' ').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function summarizePayload(payload, previewChars, fieldPaths = []) {
  const summary = {
    bytes: Buffer.byteLength(String(payload || ''), 'utf8'),
    type: 'text'
  };
  const payloadPreview = previewPayload(payload, previewChars);
  if (payloadPreview) summary.preview = payloadPreview;

  try {
    const parsed = JSON.parse(payload);
    summary.type = Array.isArray(parsed) ? 'json-array' : 'json-object';
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      summary.keys = Object.keys(parsed).slice(0, 20);
      const fields = pickPayloadFields(parsed, fieldPaths);
      if (Object.keys(fields).length) summary.fields = fields;
    }
  } catch {
    // Non-JSON payloads are still useful with byte length and preview.
  }
  return summary;
}

function pickPayloadFields(parsed, fieldPaths) {
  const defaultPaths = [
    'sn', 'status', 'statusVal', 'online', 'longitude', 'latitude', 'height', 'altitude',
    'gateway', 'timestamp', 'data.sn', 'data.mode_code', 'data.longitude', 'data.latitude',
    'data.height', 'data.capacity_percent'
  ];
  const out = {};
  for (const fieldPath of [...new Set([...defaultPaths, ...fieldPaths])]) {
    const value = getPayloadPath(parsed, fieldPath);
    if (value !== undefined && value !== null && typeof value !== 'object') out[fieldPath] = value;
  }
  return out;
}

function getPayloadPath(value, fieldPath) {
  return String(fieldPath || '').split('.').filter(Boolean)
    .reduce((current, key) => (current && typeof current === 'object' ? current[key] : undefined), value);
}

function readPayloadSamples(logDir, options) {
  const now = Date.now();
  const endTime = Number.isFinite(options.endTime) ? options.endTime : now;
  const minutes = Math.min(1440, Math.max(1, options.minutes || DEFAULT_STATUS_MINUTES));
  const startTime = Number.isFinite(options.startTime) ? options.startTime : endTime - minutes * 60_000;
  const limit = Math.min(50, Math.max(1, options.limit || DEFAULT_PAYLOAD_SAMPLE_LIMIT));
  const previewChars = Math.min(2000, Math.max(0, options.payloadPreviewChars ?? DEFAULT_PAYLOAD_PREVIEW_CHARS));
  const fieldPaths = Array.isArray(options.payloadFields) ? options.payloadFields : [];
  const topic = options.topic && options.topic.trim() ? options.topic.trim() : null;
  const topicKeyword = normalizeKeyword(options.topicKeyword || '');
  const keyword = normalizeKeyword(options.keyword || '');
  const connectionIds = options.connectionId ? [options.connectionId] : listLogConnectionIds(logDir);
  const secMin = Math.floor(Math.max(startTime, -8640000000) / 1000);
  const secMax = Math.ceil(Math.min(endTime, 8640000000000) / 1000);
  const samples = [];

  for (const connectionId of connectionIds) {
    const files = listDayFiles(logDir, connectionId, true)
      .filter((filePath) => {
        const dayKey = path.basename(filePath, '.db');
        return dayEndTsFromKey(dayKey) >= startTime && dayStartTsFromKey(dayKey) <= endTime;
      });

    for (const filePath of files) {
      if (samples.length >= limit) break;
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
          if (samples.length >= limit) break;
          if (topicKeyword && !normalizeKeyword(row.topic).includes(topicKeyword)) continue;
          const decoded = decodeBucket(row.blob, row.bucket_ts, row.topic, connectionId);
          for (let i = decoded.length - 1; i >= 0; i--) {
            const message = decoded[i];
            if (message.time < startTime || message.time > endTime) continue;
            if (keyword && !normalizeKeyword(message.topic + message.payload).includes(keyword)) continue;
            samples.push({
              time: message.time,
              localTime: formatLocalTime(message.time),
              topic: message.topic,
              payload: summarizePayload(message.payload, previewChars, fieldPaths)
            });
            if (samples.length >= limit) break;
          }
        }
      } finally {
        db.close();
      }
    }
  }

  samples.sort((a, b) => b.time - a.time);
  return {
    startTime,
    endTime,
    startLocalTime: formatLocalTime(startTime),
    endLocalTime: formatLocalTime(endTime),
    samples: samples.slice(0, limit)
  };
}

function readMessageStatus(logDir, options) {
  const now = Date.now();
  const endTime = Number.isFinite(options.endTime) ? options.endTime : now;
  const minutes = Math.min(1440, Math.max(1, options.minutes || DEFAULT_STATUS_MINUTES));
  const startTime = Number.isFinite(options.startTime) ? options.startTime : endTime - minutes * 60_000;
  const topic = options.topic && options.topic.trim() ? options.topic.trim() : null;
  const topicKeyword = normalizeKeyword(options.topicKeyword || '');
  const keyword = normalizeKeyword(options.keyword || '');
  const topicLimit = Math.min(50, Math.max(1, options.topicLimit || DEFAULT_STATUS_TOPIC_LIMIT));
  const sampleLimit = Math.min(10, Math.max(0, options.sampleLimit || 0));
  const payloadPreviewChars = Math.min(500, Math.max(0, options.payloadPreviewChars || 0));
  const connectionIds = options.connectionId ? [options.connectionId] : listLogConnectionIds(logDir);
  const secMin = Math.floor(Math.max(startTime, -8640000000) / 1000);
  const secMax = Math.ceil(Math.min(endTime, 8640000000000) / 1000);
  const topicStats = new Map();
  const samples = [];
  let total = 0;
  let latestTime = null;

  for (const connectionId of connectionIds) {
    const files = listDayFiles(logDir, connectionId, true)
      .filter((filePath) => {
        const dayKey = path.basename(filePath, '.db');
        return dayEndTsFromKey(dayKey) >= startTime && dayStartTsFromKey(dayKey) <= endTime;
      });

    for (const filePath of files) {
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
          if (topicKeyword && !normalizeKeyword(row.topic).includes(topicKeyword)) continue;
          const decoded = decodeBucket(row.blob, row.bucket_ts, row.topic, connectionId);
          for (let i = decoded.length - 1; i >= 0; i--) {
            const message = decoded[i];
            if (message.time < startTime || message.time > endTime) continue;
            if (keyword && !normalizeKeyword(message.topic + message.payload).includes(keyword)) continue;

            total += 1;
            latestTime = latestTime === null ? message.time : Math.max(latestTime, message.time);
            const stat = topicStats.get(message.topic) || { topic: message.topic, count: 0, latestTime: message.time };
            stat.count += 1;
            stat.latestTime = Math.max(stat.latestTime, message.time);
            topicStats.set(message.topic, stat);
            if (samples.length < sampleLimit) {
              const sample = {
                time: message.time,
                localTime: formatLocalTime(message.time),
                topic: message.topic
              };
              const payloadPreview = previewPayload(message.payload, payloadPreviewChars);
              if (payloadPreview) sample.payloadPreview = payloadPreview;
              samples.push(sample);
            }
          }
        }
      } finally {
        db.close();
      }
    }
  }

  const topics = [...topicStats.values()]
    .sort((a, b) => b.latestTime - a.latestTime || b.count - a.count)
    .slice(0, topicLimit)
    .map((item) => ({
      topic: item.topic,
      count: item.count,
      latestTime: item.latestTime,
      latestLocalTime: formatLocalTime(item.latestTime)
    }));

  return {
    hasMessages: total > 0,
    total,
    startTime,
    endTime,
    startLocalTime: formatLocalTime(startTime),
    endLocalTime: formatLocalTime(endTime),
    latestTime,
    latestLocalTime: formatLocalTime(latestTime),
    topics,
    samples
  };
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
        connectionId: z.string().optional().describe('MQTTMountain connection id. Use mqttmountain_connections first if unsure.'),
        connectionName: z.string().optional().describe('MQTTMountain connection name, for example "深圳星扬".'),
        connectionKeyword: z.string().optional().describe('Fuzzy connection keyword, for example "深圳星扬" or "xingyang-szga".'),
        topic: z.string().optional().describe('Exact MQTT topic filter.'),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(100)
      })
    },
    async (input) => {
      const connectionId = resolveConnectionId(userDataDir, logDir, input);
      if (!connectionId) throw new Error('connectionId or connectionName is required.');
      return jsonText({
        logDir,
        connectionId,
        connectionName: input.connectionName,
        topic: input.topic,
        messages: readRecentMessages(logDir, connectionId, input.limit, input.topic)
      });
    }
  );

  server.registerTool(
    'mqttmountain_message_status',
    {
      title: 'Read Compact MQTT Message Status',
      description: 'One-call compact summary for checking whether recent messages arrived. Returns counts, latest time, and hot topics without full payloads by default.',
      inputSchema: z.object({
        connectionId: z.string().optional().describe('Optional MQTTMountain connection id.'),
        connectionName: z.string().optional().describe('Optional exact MQTTMountain connection name.'),
        connectionKeyword: z.string().optional().describe('Fuzzy connection keyword, for example "深圳星扬" or "xingyang-szga".'),
        topic: z.string().optional().describe('Exact MQTT topic filter.'),
        topicKeyword: z.string().optional().describe('Substring search in topic only.'),
        keyword: z.string().optional().describe('Substring search across topic and payload. Whitespace is ignored.'),
        minutes: z.number().int().min(1).max(1440).default(DEFAULT_STATUS_MINUTES).describe('Lookback window in minutes when startTime is omitted.'),
        startTime: z.number().optional().describe('Start timestamp in milliseconds since Unix epoch.'),
        endTime: z.number().optional().describe('End timestamp in milliseconds since Unix epoch. Defaults to now.'),
        topicLimit: z.number().int().min(1).max(50).default(DEFAULT_STATUS_TOPIC_LIMIT),
        sampleLimit: z.number().int().min(0).max(10).default(0).describe('Number of recent sample messages to include. Defaults to 0 to save tokens.'),
        payloadPreviewChars: z.number().int().min(0).max(500).default(0).describe('Payload preview length for samples. Defaults to 0 to save tokens.')
      })
    },
    async (input) => {
      const connectionId = resolveConnectionId(userDataDir, logDir, input);
      const query = connectionId ? { ...input, connectionId } : input;
      return jsonText({
        connectionId,
        connectionName: input.connectionName,
        connectionKeyword: input.connectionKeyword,
        status: readMessageStatus(logDir, query)
      });
    }
  );

  server.registerTool(
    'mqttmountain_payload_samples',
    {
      title: 'Read Compact MQTT Payload Samples',
      description: 'Read latest payload samples with compact JSON keys, common fields, and short previews.',
      inputSchema: z.object({
        connectionId: z.string().optional().describe('Optional MQTTMountain connection id.'),
        connectionName: z.string().optional().describe('Optional exact MQTTMountain connection name.'),
        connectionKeyword: z.string().optional().describe('Fuzzy connection keyword, for example "深圳星扬" or "xingyang-szga".'),
        topic: z.string().optional().describe('Exact MQTT topic filter.'),
        topicKeyword: z.string().optional().describe('Substring search in topic only.'),
        keyword: z.string().optional().describe('Substring search across topic and payload. Whitespace is ignored.'),
        minutes: z.number().int().min(1).max(1440).default(DEFAULT_STATUS_MINUTES).describe('Lookback window in minutes when startTime is omitted.'),
        startTime: z.number().optional().describe('Start timestamp in milliseconds since Unix epoch.'),
        endTime: z.number().optional().describe('End timestamp in milliseconds since Unix epoch. Defaults to now.'),
        limit: z.number().int().min(1).max(50).default(DEFAULT_PAYLOAD_SAMPLE_LIMIT),
        payloadPreviewChars: z.number().int().min(0).max(2000).default(DEFAULT_PAYLOAD_PREVIEW_CHARS),
        payloadFields: z.array(z.string()).optional().describe('Extra JSON field paths to extract, for example ["data.battery","data.mode_code"].')
      })
    },
    async (input) => {
      const connectionId = resolveConnectionId(userDataDir, logDir, input);
      const query = connectionId ? { ...input, connectionId } : input;
      return jsonText({
        connectionId,
        connectionName: input.connectionName,
        connectionKeyword: input.connectionKeyword,
        result: readPayloadSamples(logDir, query)
      });
    }
  );

  server.registerTool(
    'mqttmountain_query_history',
    {
      title: 'Query MQTT Message History',
      description: 'Query persisted MQTTMountain messages by connection, topic, keyword, and timestamp range.',
      inputSchema: z.object({
        connectionId: z.string().optional().describe('Optional MQTTMountain connection id. Omit to search all log folders.'),
        connectionName: z.string().optional().describe('Optional MQTTMountain connection name, for example "深圳星扬".'),
        connectionKeyword: z.string().optional().describe('Fuzzy connection keyword, for example "深圳星扬" or "xingyang-szga".'),
        topic: z.string().optional().describe('Exact MQTT topic filter.'),
        keyword: z.string().optional().describe('Substring search across topic and payload. Whitespace is ignored.'),
        startTime: z.number().optional().describe('Start timestamp in milliseconds since Unix epoch.'),
        endTime: z.number().optional().describe('End timestamp in milliseconds since Unix epoch.'),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(200)
      })
    },
    async (input) => {
      const connectionId = resolveConnectionId(userDataDir, logDir, input);
      const query = connectionId ? { ...input, connectionId } : input;
      return jsonText({
        logDir,
        query,
        messages: queryHistory(logDir, query)
      });
    }
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`[mqttmountain-mcp] ${error?.stack || error}\n`);
  process.exit(1);
});
