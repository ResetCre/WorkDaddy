'use strict';

const fs = require('fs');
const path = require('path');
const { createSessionDb } = require('./session-db.js');

const INSERT_USAGE_SQL = `
  INSERT INTO credit_usage_records
    (profile_id, uid, request_id, request_time, usage_date, credit, model, client, agent_purpose)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(profile_id, uid, request_id) DO UPDATE SET
    request_time = excluded.request_time,
    usage_date = excluded.usage_date,
    credit = excluded.credit,
    model = excluded.model,
    client = excluded.client,
    agent_purpose = excluded.agent_purpose
`;

function validIdentity(value, label) {
  const text = String(value || '').trim();
  if (!text || text.length > 512 || text.includes('\0')) throw new Error(`${label} 无效`);
  return text;
}

// 同一模型可能由不同上报路径写成只差分隔符/大小写的 model_id
// （Step-5-Preview / step-5-preview、Hy4 preview / Hy4-preview），
// 只按小写去重会把它们当成两个模型，界面出现重复行。
function normalizeModelKey(modelId) {
  return String(modelId || '').toLowerCase().replace(/[\s\-_./\\]+/g, '');
}

function localDayRange(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!match) throw new Error('用量日期无效');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
    throw new Error('用量日期无效');
  }
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}

function validDate(value) {
  const text = String(value || '');
  localDayRange(text);
  return text;
}

function createCreditUsageStore(options = {}) {
  const dbPath = path.resolve(String(options.dbPath || ''));
  const profileId = validIdentity(options.profileId, 'profile id');
  const db = options.adapter || createSessionDb({ dbPath });
  let initPromise = null;

  function initialize() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
      await db.run(`
        CREATE TABLE IF NOT EXISTS credit_usage_records (
          profile_id TEXT NOT NULL,
          uid TEXT NOT NULL,
          request_id TEXT NOT NULL,
          request_time INTEGER NOT NULL,
          usage_date TEXT NOT NULL,
          credit REAL NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          client TEXT NOT NULL DEFAULT '',
          agent_purpose TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (profile_id, uid, request_id)
        )
      `);
      await db.run(`
        CREATE INDEX IF NOT EXISTS idx_credit_usage_uid_date
        ON credit_usage_records (profile_id, uid, usage_date, request_time)
      `);
      await db.run(`
        CREATE TABLE IF NOT EXISTS credit_usage_sync_state (
          profile_id TEXT NOT NULL,
          uid TEXT NOT NULL,
          anchor_request_id TEXT,
          last_success_at INTEGER NOT NULL,
          PRIMARY KEY (profile_id, uid)
        )
      `);
      await db.run(`
        CREATE TABLE IF NOT EXISTS credit_history_days (
          profile_id TEXT NOT NULL, uid TEXT NOT NULL, usage_date TEXT NOT NULL,
          synced_at INTEGER NOT NULL, PRIMARY KEY (profile_id, uid, usage_date)
        )
      `);
      // 5 秒轮询的 IDEA 采样：只在「IDEA 累计值发生变化」时落一行，
      // 空转不写库，避免 5 秒一条把表撑爆。
      await db.run(`
        CREATE TABLE IF NOT EXISTS idea_usage_samples (
          profile_id TEXT NOT NULL,
          uid TEXT NOT NULL,
          captured_at INTEGER NOT NULL,
          idea_credit REAL NOT NULL DEFAULT 0,
          desktop_credit REAL NOT NULL DEFAULT 0,
          total_credit REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (profile_id, uid, captured_at)
        )
      `);
      await db.run(`
        CREATE INDEX IF NOT EXISTS idx_idea_usage_samples_uid_at
        ON idea_usage_samples (profile_id, uid, captured_at)
      `);
      // IDE 插件本地会话的逐条用量（来自插件的 history/<workspace>/<conv>/index.json）。
      // 官方接口不提供 token，这里同时存 credit 与 token，是 IDE 页签的唯一数据源。
      await db.run(`
        CREATE TABLE IF NOT EXISTS idea_request_usage (
          profile_id TEXT NOT NULL,
          uid TEXT NOT NULL,
          request_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          usage_date TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          cache_tokens INTEGER NOT NULL DEFAULT 0,
          credit REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (profile_id, uid, request_id)
        )
      `);
      await db.run(`
        CREATE INDEX IF NOT EXISTS idx_idea_request_usage_uid_date
        ON idea_request_usage (profile_id, uid, usage_date)
      `);
      await db.run(`
        CREATE TABLE IF NOT EXISTS daily_checkin_records (
          profile_id TEXT NOT NULL,
          uid TEXT NOT NULL,
          checkin_date TEXT NOT NULL,
          checked_at INTEGER NOT NULL,
          response_code INTEGER,
          message TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (profile_id, uid, checkin_date)
        )
      `);
      await db.run(`
        CREATE INDEX IF NOT EXISTS idx_daily_checkin_uid_date
        ON daily_checkin_records (profile_id, uid, checkin_date)
      `);
      await db.run(`
        CREATE TABLE IF NOT EXISTS model_rate_limit_records (
          profile_id TEXT NOT NULL,
          uid TEXT NOT NULL,
          model_id TEXT NOT NULL,
          model_name TEXT NOT NULL DEFAULT '',
          reset_at INTEGER,
          observed_at INTEGER NOT NULL,
          source TEXT NOT NULL DEFAULT '',
          reason_code INTEGER,
          PRIMARY KEY (profile_id, uid, model_id)
        )
      `);
      await db.run(`
        CREATE INDEX IF NOT EXISTS idx_model_rate_limit_uid_reset
        ON model_rate_limit_records (profile_id, uid, reset_at)
      `);
      try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
    return initPromise;
  }

  async function getSyncState(uid) {
    await initialize();
    const accountUid = validIdentity(uid, 'uid');
    const rows = await db.all(
      `SELECT anchor_request_id, last_success_at
       FROM credit_usage_sync_state
       WHERE profile_id = ? AND uid = ?
       LIMIT 1`,
      [profileId, accountUid]
    );
    if (!rows.length) return null;
    return {
      anchorRequestId: rows[0].anchor_request_id || '',
      lastSuccessAt: Number(rows[0].last_success_at),
    };
  }

  async function saveRecords(accountUid, records) {
    const list = Array.isArray(records) ? records : [];
    for (let offset = 0; offset < list.length; offset += 200) {
      const statements = list.slice(offset, offset + 200).map((record) => ({
        sql: INSERT_USAGE_SQL,
        params: [
          profileId,
          accountUid,
          validIdentity(record.requestId, 'request id'),
          Number(record.requestTime),
          String(record.usageDate || ''),
          Number(record.credit),
          String(record.model || ''),
          String(record.client || ''),
          String(record.agentPurpose || ''),
        ],
      }));
      if (statements.length) await db.transaction(statements);
    }
  }

  async function saveHistoryUsage({ uid, records, from, to, syncedAt }) {
    await initialize();
    const accountUid = validIdentity(uid, 'uid');
    const start = localDayRange(validDate(from)).start;
    const end = localDayRange(validDate(to)).start;
    if (start > end || end - start > 90 * 86400000) throw new Error('用量日期范围无效');
    if (!Number.isSafeInteger(syncedAt) || syncedAt < 0) throw new Error('同步时间无效');
    await saveRecords(accountUid, records);
    const days = [];
    for (const date = new Date(start); date.getTime() <= end; date.setDate(date.getDate() + 1)) {
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      days.push({ sql: `INSERT INTO credit_history_days (profile_id, uid, usage_date, synced_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(profile_id, uid, usage_date) DO UPDATE SET synced_at = excluded.synced_at`,
        params: [profileId, accountUid, day, syncedAt] });
    }
    await db.transaction(days);
    try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
  }

  async function saveSuccessfulSync({ uid, records, anchorRequestId, syncedAt }) {
    await initialize();
    const accountUid = validIdentity(uid, 'uid');
    const timestamp = Number(syncedAt);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('同步时间无效');
    await saveRecords(accountUid, records);
    await db.run(
      `INSERT INTO credit_usage_sync_state
         (profile_id, uid, anchor_request_id, last_success_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, uid) DO UPDATE SET
         anchor_request_id = excluded.anchor_request_id,
         last_success_at = excluded.last_success_at`,
      [profileId, accountUid, anchorRequestId ? validIdentity(anchorRequestId, 'anchor request id') : null, timestamp]
    );
    try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
  }

  async function listDailyUsage(uids, date) {
    await initialize();
    const accountUids = Array.from(new Set((Array.isArray(uids) ? uids : []).map((uid) => validIdentity(uid, 'uid'))));
    if (!accountUids.length) return {};
    const usageDate = String(date || '');
    const dayRange = localDayRange(usageDate);
    const placeholders = accountUids.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT uid, ROUND(SUM(credit), 2) AS used, COUNT(*) AS count
       FROM credit_usage_records
       WHERE profile_id = ? AND usage_date = ? AND uid IN (${placeholders})
       GROUP BY uid`,
      [profileId, usageDate, ...accountUids]
    );
    const result = {};
    for (const row of rows) {
      const count = Number(row.count);
      const used = Number(row.used);
      if (!accountUids.includes(row.uid) || !Number.isFinite(used) || !Number.isSafeInteger(count) || count <= 0) continue;
      result[row.uid] = { date: usageDate, used, count, synced: true };
    }
    const syncedRows = await db.all(
      `SELECT uid
       FROM credit_usage_sync_state
       WHERE profile_id = ? AND uid IN (${placeholders})
         AND last_success_at >= ? AND last_success_at < ?`,
      [profileId, ...accountUids, dayRange.start, dayRange.end]
    );
    for (const row of syncedRows) {
      if (!accountUids.includes(row.uid) || result[row.uid]) continue;
      result[row.uid] = { date: usageDate, used: 0, count: 0, synced: true };
    }
    return result;
  }

  async function dailyUsageForUid(uid, date) {
    const accountUid = validIdentity(uid, 'uid');
    const summaries = await listDailyUsage([accountUid], date);
    return summaries[accountUid] || null;
  }

  // 全部（历史累计）积分消耗：直接汇总 credit_usage_records，与 workbuddy-switch
  // 「本地统计消耗」思路一致——不依赖官方计费接口，用本机已记录的用量求和。
  async function totalUsageForUids(uids) {
    await initialize();
    const accountUids = Array.from(new Set((Array.isArray(uids) ? uids : []).map((uid) => validIdentity(uid, 'uid'))));
    if (!accountUids.length) return {};
    const placeholders = accountUids.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT uid, ROUND(SUM(credit), 2) AS total
       FROM credit_usage_records
       WHERE profile_id = ? AND uid IN (${placeholders})
       GROUP BY uid`,
      [profileId, ...accountUids]
    );
    const result = {};
    for (const row of rows) {
      const total = Number(row.total);
      if (!accountUids.includes(row.uid) || !Number.isFinite(total)) continue;
      result[row.uid] = total;
    }
    return result;
  }

  // 按客户端（WorkBuddy 桌面端 / JetBrainsIntelliJIdea 插件）聚合本地已同步的官方明细。
  // 官方明细接口只回最近 31 天，IDEA 拆分只能逐日落库后本地累加，这里读的就是累加结果。
  // today 传入时额外返回当日各客户端小计（供卡片「今日/累计」展示）。
  async function clientUsageForUids(uids, today) {
    await initialize();
    const accountUids = Array.from(new Set((Array.isArray(uids) ? uids : []).map((uid) => validIdentity(uid, 'uid'))));
    if (!accountUids.length) return {};
    const placeholders = accountUids.map(() => '?').join(',');
    const day = today ? validDate(today) : '';
    const rows = await db.all(
      `SELECT uid, client, ${day ? 'usage_date = ?' : '0'} AS is_today,
              ROUND(SUM(credit), 2) AS credit, COUNT(*) AS cnt,
              MIN(usage_date) AS first_date, MAX(usage_date) AS last_date
       FROM credit_usage_records
       WHERE profile_id = ? AND uid IN (${placeholders})
       GROUP BY uid, client, is_today`,
      day ? [day, profileId, ...accountUids] : [profileId, ...accountUids]
    );
    const result = {};
    for (const row of rows) {
      if (!accountUids.includes(row.uid)) continue;
      const credit = Number(row.credit);
      if (!Number.isFinite(credit)) continue;
      const entry = result[row.uid] || (result[row.uid] = {
        total: 0, count: 0, from: '', to: '', clients: {},
        today: 0, todayClients: {}, lastSampleAt: 0,
      });
      const name = String(row.client || '');
      entry.total = Math.round((entry.total + credit) * 100) / 100;
      entry.count += Number(row.cnt) || 0;
      const first = String(row.first_date || '');
      const last = String(row.last_date || '');
      if (first && (!entry.from || first < entry.from)) entry.from = first;
      if (last && (!entry.to || last > entry.to)) entry.to = last;
      entry.clients[name] = Math.round(((entry.clients[name] || 0) + credit) * 100) / 100;
      // is_today 的行既是当日用量，也是总累计的一部分，两边都要累加。
      if (Number(row.is_today) === 1) {
        entry.today = Math.round((entry.today + credit) * 100) / 100;
        entry.todayClients[name] = Math.round(((entry.todayClients[name] || 0) + credit) * 100) / 100;
      }
    }
    const samples = await db.all(
      `SELECT uid, MAX(captured_at) AS at FROM idea_usage_samples
       WHERE profile_id = ? AND uid IN (${placeholders}) GROUP BY uid`,
      [profileId, ...accountUids]
    );
    for (const row of samples) {
      if (result[row.uid]) result[row.uid].lastSampleAt = Number(row.at) || 0;
    }
    return result;
  }

  // 5 秒轮询只补明细，不写覆盖标记（窄窗口并不代表整日已同步）。
  async function savePolledUsage(uid, records) {
    await initialize();
    const accountUid = validIdentity(uid, 'uid');
    await saveRecords(accountUid, records);
    try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
  }

  // 写入 IDE 插件本地会话的逐条用量（request_id 幂等 upsert）。
  async function saveIdeaRequests(uid, rows) {
    await initialize();
    const accountUid = validIdentity(uid, 'uid');
    const list = Array.isArray(rows) ? rows : [];
    for (let offset = 0; offset < list.length; offset += 200) {
      const statements = list.slice(offset, offset + 200).map((row) => ({
        sql: `INSERT INTO idea_request_usage
                (profile_id, uid, request_id, started_at, usage_date,
                 input_tokens, output_tokens, total_tokens, cache_tokens, credit)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(profile_id, uid, request_id) DO UPDATE SET
                started_at = excluded.started_at, usage_date = excluded.usage_date,
                input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
                total_tokens = excluded.total_tokens, cache_tokens = excluded.cache_tokens,
                credit = excluded.credit`,
        params: [
          profileId, accountUid,
          validIdentity(row.requestId, 'request id'),
          Number(row.startedAt) || 0,
          String(row.usageDate || '').slice(0, 10),
          Number(row.inputTokens) || 0,
          Number(row.outputTokens) || 0,
          Number(row.totalTokens) || 0,
          Number(row.cacheTokens) || 0,
          Number(row.credit) || 0,
        ],
      }));
      if (statements.length) await db.transaction(statements);
    }
    try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
  }

  // IDE 插件本地会话的汇总（今日/全部，credit + token）。
  async function ideaUsageSummary(uids, today) {
    await initialize();
    const accountUids = Array.from(new Set((Array.isArray(uids) ? uids : []).map((uid) => validIdentity(uid, 'uid'))));
    if (!accountUids.length) return {};
    const placeholders = accountUids.map(() => '?').join(',');
    const day = today ? validDate(today) : '';
    const rows = await db.all(
      `SELECT uid, ${day ? 'usage_date = ?' : '0'} AS is_today,
              ROUND(SUM(credit), 2) AS credit, SUM(total_tokens) AS tokens, COUNT(*) AS cnt,
              MIN(usage_date) AS first_date, MAX(usage_date) AS last_date
       FROM idea_request_usage
       WHERE profile_id = ? AND uid IN (${placeholders})
       GROUP BY uid, is_today`,
      day ? [day, profileId, ...accountUids] : [profileId, ...accountUids]
    );
    const result = {};
    for (const row of rows) {
      if (!accountUids.includes(row.uid)) continue;
      const credit = Number(row.credit) || 0;
      const tokens = Number(row.tokens) || 0;
      const entry = result[row.uid] || (result[row.uid] = {
        totalCredit: 0, totalTokens: 0, todayCredit: 0, todayTokens: 0,
        count: 0, from: '', to: '',
      });
      entry.totalCredit = Math.round((entry.totalCredit + credit) * 100) / 100;
      entry.totalTokens += tokens;
      entry.count += Number(row.cnt) || 0;
      const first = String(row.first_date || '');
      const last = String(row.last_date || '');
      if (first && (!entry.from || first < entry.from)) entry.from = first;
      if (last && (!entry.to || last > entry.to)) entry.to = last;
      if (Number(row.is_today) === 1) {
        entry.todayCredit = Math.round((entry.todayCredit + credit) * 100) / 100;
        entry.todayTokens += tokens;
      }
    }
    return result;
  }

  // 记录一次 IDEA 采样；与上一条相同则跳过，只保留「发生变化」的时间点。
  async function recordIdeaSample({ uid, capturedAt, ideaCredit, desktopCredit, totalCredit }) {
    await initialize();
    const accountUid = validIdentity(uid, 'uid');
    const at = Number(capturedAt);
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('采样时间无效');
    const idea = Math.round(Number(ideaCredit || 0) * 100) / 100;
    const prev = await db.all(
      `SELECT idea_credit FROM idea_usage_samples
       WHERE profile_id = ? AND uid = ? ORDER BY captured_at DESC LIMIT 1`,
      [profileId, accountUid]
    );
    if (prev.length && Number(prev[0].idea_credit) === idea) return false;
    await db.run(
      `INSERT INTO idea_usage_samples
         (profile_id, uid, captured_at, idea_credit, desktop_credit, total_credit)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [profileId, accountUid, at, idea,
        Math.round(Number(desktopCredit || 0) * 100) / 100,
        Math.round(Number(totalCredit || 0) * 100) / 100]
    );
    // 采样只用于观察变化趋势，保留 7 天足够。
    await db.run(
      `DELETE FROM idea_usage_samples WHERE profile_id = ? AND uid = ? AND captured_at < ?`,
      [profileId, accountUid, at - 7 * 86400000]
    );
    return true;
  }

  async function listDailyUsageRange(uids, fromDate, toDate) {
    await initialize();
    const accountUids = Array.from(new Set((Array.isArray(uids) ? uids : []).map((uid) => validIdentity(uid, 'uid'))));
    if (!accountUids.length) return [];
    const from = validDate(fromDate);
    const to = validDate(toDate);
    if (from > to) throw new Error('用量日期范围无效');
    const placeholders = accountUids.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT uid, usage_date AS date, ROUND(SUM(credit), 2) AS used, COUNT(*) AS count
       FROM credit_usage_records
       WHERE profile_id = ? AND usage_date >= ? AND usage_date <= ? AND uid IN (${placeholders})
       GROUP BY uid, usage_date ORDER BY usage_date ASC, uid ASC`,
      [profileId, from, to, ...accountUids]
    );
    const result = new Map(rows.map(row => [row.uid + ':' + row.date,
      { uid: String(row.uid), date: String(row.date), used: Number(row.used) || 0, count: Number(row.count) || 0, cached: true, complete: false }]));
    const coverage = await db.all(`SELECT uid, usage_date, synced_at FROM credit_history_days
      WHERE profile_id = ? AND usage_date >= ? AND usage_date <= ? AND uid IN (${placeholders})`,
      [profileId, from, to, ...accountUids]);
    for (const row of coverage) {
      const key = row.uid + ':' + row.usage_date;
      const item = result.get(key) || { uid: row.uid, date: row.usage_date, used: 0, count: 0, cached: true };
      item.complete = true; item.syncedAt = Number(row.synced_at);
      result.set(key, item);
    }
    return Array.from(result.values()).sort((a, b) => a.date.localeCompare(b.date) || a.uid.localeCompare(b.uid));
  }

  async function getDailyCheckin(uid, date) {
    await initialize();
    const accountUid = validIdentity(uid, 'uid');
    const checkinDate = validDate(date);
    const rows = await db.all(
      `SELECT checkin_date, checked_at, response_code, message
       FROM daily_checkin_records
       WHERE profile_id = ? AND uid = ? AND checkin_date = ?
       LIMIT 1`,
      [profileId, accountUid, checkinDate]
    );
    if (!rows.length) return null;
    return {
      date: rows[0].checkin_date,
      ok: true,
      already: Number(rows[0].response_code) === 10001,
      code: rows[0].response_code === null ? null : Number(rows[0].response_code),
      message: String(rows[0].message || ''),
      at: Number(rows[0].checked_at),
      verified: true,
    };
  }

  async function listDailyCheckins(uids, date) {
    await initialize();
    const accountUids = Array.from(new Set((Array.isArray(uids) ? uids : []).map((uid) => validIdentity(uid, 'uid'))));
    const checkinDate = validDate(date);
    if (!accountUids.length) return {};
    const placeholders = accountUids.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT uid, checkin_date, checked_at, response_code, message
       FROM daily_checkin_records
       WHERE profile_id = ? AND checkin_date = ? AND uid IN (${placeholders})`,
      [profileId, checkinDate, ...accountUids]
    );
    const result = {};
    for (const row of rows) {
      if (!accountUids.includes(row.uid)) continue;
      result[row.uid] = {
        date: row.checkin_date,
        ok: true,
        already: Number(row.response_code) === 10001,
        code: row.response_code === null ? null : Number(row.response_code),
        message: String(row.message || ''),
        at: Number(row.checked_at),
        verified: true,
      };
    }
    return result;
  }

  async function saveDailyCheckin({ uid, date, checkedAt, code, message }) {
    await initialize();
    const accountUid = validIdentity(uid, 'uid');
    const checkinDate = validDate(date);
    const timestamp = Number(checkedAt);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('签到时间无效');
    const responseCode = code === null || code === undefined ? null : Number(code);
    if (responseCode !== null && !Number.isSafeInteger(responseCode)) throw new Error('签到响应 code 无效');
    await db.run(
      `INSERT INTO daily_checkin_records
         (profile_id, uid, checkin_date, checked_at, response_code, message)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, uid, checkin_date) DO UPDATE SET
         checked_at = excluded.checked_at,
         response_code = excluded.response_code,
         message = excluded.message`,
      [profileId, accountUid, checkinDate, timestamp, responseCode, String(message || '')]
    );
    try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
  }

  async function saveModelRateLimit({ uid, modelId, modelName, resetAt, observedAt, source, reasonCode }) {
    await initialize();
    const accountUid = validIdentity(uid, 'uid');
    const id = validIdentity(modelId, 'model id');
    const name = String(modelName || '').slice(0, 256);
    const observed = Number(observedAt);
    if (!Number.isSafeInteger(observed) || observed < 0) throw new Error('限流观察时间无效');
    let reset = resetAt === null || resetAt === undefined || resetAt === '' ? null : Number(resetAt);
    if (reset !== null && (!Number.isSafeInteger(reset) || reset < 0)) throw new Error('限流解封时间无效');
    const reason = reasonCode === null || reasonCode === undefined ? null : Number(reasonCode);
    if (reason !== null && !Number.isSafeInteger(reason)) throw new Error('限流 code 无效');
    // 同一模型可能由不同上报路径写成仅分隔符/大小写不同的 model_id，主键区分大小写会落成两条重复行。
    // 写入前先清掉同账号的等价变体，保证一个模型只留一条。
    const targetKey = normalizeModelKey(id);
    const existingIds = await db.all(
      `SELECT model_id FROM model_rate_limit_records WHERE profile_id = ? AND uid = ?`,
      [profileId, accountUid]
    );
    for (const row of existingIds) {
      const existingId = String(row.model_id || '');
      if (existingId === id || normalizeModelKey(existingId) !== targetKey) continue;
      await db.run(
        `DELETE FROM model_rate_limit_records WHERE profile_id = ? AND uid = ? AND model_id = ?`,
        [profileId, accountUid, existingId]
      );
    }
    await db.run(
      `INSERT INTO model_rate_limit_records
         (profile_id, uid, model_id, model_name, reset_at, observed_at, source, reason_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, uid, model_id) DO UPDATE SET
         model_name = excluded.model_name,
         reset_at = excluded.reset_at,
         observed_at = excluded.observed_at,
         source = excluded.source,
         reason_code = excluded.reason_code`,
      [profileId, accountUid, id, name, reset, observed, String(source || '').slice(0, 80), reason]
    );
    try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
  }

  async function hasModelRateLimitElsewhere({ uid, modelId, resetAt, now }) {
    await initialize();
    const accountUid = validIdentity(uid, 'uid');
    const id = validIdentity(modelId, 'model id');
    const reset = Number(resetAt);
    if (!Number.isSafeInteger(reset) || reset < 0) throw new Error('限流解封时间无效');
    const timestamp = Number(now === undefined ? Date.now() : now);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('限流查询时间无效');
    const rows = await db.all(
      `SELECT 1
       FROM model_rate_limit_records
       WHERE profile_id = ? AND uid <> ? AND lower(model_id) = lower(?) AND reset_at = ? AND reset_at > ?
       LIMIT 1`,
      [profileId, accountUid, id, reset, timestamp]
    );
    return rows.length > 0;
  }

  async function listModelRateLimits(uids, now) {
    await initialize();
    const accountUids = Array.from(new Set((Array.isArray(uids) ? uids : []).map((uid) => validIdentity(uid, 'uid'))));
    if (!accountUids.length) return {};
    const timestamp = Number(now === undefined ? Date.now() : now);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('限流查询时间无效');
    const placeholders = accountUids.map(() => '?').join(',');
    await db.run(
      `DELETE FROM model_rate_limit_records
       WHERE profile_id = ? AND reset_at IS NOT NULL AND reset_at <= ? AND uid IN (${placeholders})`,
      [profileId, timestamp, ...accountUids]
    );
    const rows = await db.all(
      `SELECT uid, model_id, model_name, reset_at, observed_at, source, reason_code
       FROM model_rate_limit_records
       WHERE profile_id = ? AND uid IN (${placeholders})
       ORDER BY uid ASC, observed_at DESC, model_id ASC`,
      [profileId, ...accountUids]
    );
    const result = {};
    const seen = new Set();
    const seenReset = new Set();
    // 限流记录只有 reset_at 一个失效条件：模型其实已恢复（限流之后又成功用过），
    // 但 reset_at 还没到，界面就会一直挂着"限流中"。这里用成功用量反证恢复并清理。
    const recovered = new Set();
    if (rows.length) {
      const oldestObserved = rows.reduce((min, row) => Math.min(min, Number(row.observed_at) || 0), Number.MAX_SAFE_INTEGER);
      const usageRows = await db.all(
        `SELECT uid, model, MAX(request_time) AS last_ok
         FROM credit_usage_records
         WHERE profile_id = ? AND uid IN (${placeholders}) AND request_time >= ?
         GROUP BY uid, model`,
        [profileId, ...accountUids, oldestObserved]
      );
      const lastOkByModel = new Map();
      for (const usage of usageRows) {
        lastOkByModel.set(usage.uid + '|' + normalizeModelKey(usage.model), Number(usage.last_ok) || 0);
      }
      for (const row of rows) {
        const lastOk = lastOkByModel.get(row.uid + '|' + normalizeModelKey(row.model_id)) || 0;
        if (!lastOk || lastOk <= (Number(row.observed_at) || 0)) continue;
        recovered.add(row.uid + '|' + row.model_id);
        await db.run(
          `DELETE FROM model_rate_limit_records WHERE profile_id = ? AND uid = ? AND model_id = ?`,
          [profileId, row.uid, row.model_id]
        );
      }
    }
    for (const row of rows) {
      if (!accountUids.includes(row.uid)) continue;
      if (recovered.has(row.uid + '|' + row.model_id)) continue;
      // 兼容历史重复：同一账号同一模型只保留最近观察的一条（rows 已按 observed_at DESC 排序）。
      const dedupKey = row.uid + '|' + normalizeModelKey(row.model_id);
      if (seen.has(dedupKey)) continue;
      // 同一次限流事件会被写成多条（上报时取的是当时会话的模型名），
      // reset_at 完全相同就按同一个事件处理，只留最近观察的一条。
      if (row.reset_at !== null) {
        const resetKey = row.uid + '|' + row.reset_at;
        if (seenReset.has(resetKey)) continue;
        seenReset.add(resetKey);
      }
      seen.add(dedupKey);
      if (!result[row.uid]) result[row.uid] = [];
      result[row.uid].push({
        modelId: String(row.model_id), modelName: String(row.model_name || ''),
        resetAt: row.reset_at === null ? null : Number(row.reset_at),
        observedAt: Number(row.observed_at), source: String(row.source || ''),
        reasonCode: row.reason_code === null ? null : Number(row.reason_code),
      });
    }
    return result;
  }

  return {
    dailyUsageForUid,
    totalUsageForUids,
    clientUsageForUids,
    savePolledUsage,
    saveIdeaRequests,
    ideaUsageSummary,
    recordIdeaSample,
    listDailyUsageRange,
    getDailyCheckin,
    listDailyCheckins,
    getSyncState,
    initialize,
    listDailyUsage,
    saveSuccessfulSync,
    saveHistoryUsage,
    saveDailyCheckin,
    saveModelRateLimit,
    hasModelRateLimitElsewhere,
    listModelRateLimits,
  };
}

module.exports = { createCreditUsageStore };
