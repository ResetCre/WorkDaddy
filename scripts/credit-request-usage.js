'use strict';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatLocalDateTime(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function startOfLocalDay(date) {
  const result = new Date(date.getTime());
  result.setHours(0, 0, 0, 0);
  return result;
}

function parseRequestTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value).replace(/^(\d{4}-\d\d-\d\d)\s+/, '$1T'));
  return Number.isFinite(parsed) ? parsed : null;
}

function localDateString(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function safeText(value, maxLength = 200) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\0/g, '').slice(0, maxLength);
}

// The billing endpoint has returned model metadata in several shapes over
// time. Keep the model key readable and stable without persisting the raw
// upstream object.
function modelText(value, depth = 0) {
  if (typeof value === 'string' || typeof value === 'number') return safeText(value).trim();
  if (!value || typeof value !== 'object' || depth > 2) return '';
  for (const key of ['name', 'modelName', 'model_name', 'id', 'modelId', 'model_id', 'slug']) {
    const text = modelText(value[key], depth + 1);
    if (text) return text;
  }
  return '';
}

function usageModel(row) {
  for (const key of ['model', 'modelName', 'model_name', 'modelId', 'model_id', 'modelInfo', 'model_info']) {
    const text = modelText(row[key]);
    if (text) return text;
  }
  return '';
}

function normalizeUsageRow(row) {
  if (!row || typeof row !== 'object') throw new Error('用量记录不是对象');
  const requestId = safeText(row.requestId, 512).trim();
  const requestTime = parseRequestTime(row.requestTime);
  const credit = Number(row.credit);
  if (!requestId) throw new Error('用量记录缺少 requestId');
  if (requestTime === null) throw new Error(`用量记录 ${requestId.slice(0, 12)} 缺少有效 requestTime`);
  if (!Number.isFinite(credit) || credit < 0) throw new Error(`用量记录 ${requestId.slice(0, 12)} 的 credit 无效`);
  return {
    requestId,
    requestTime,
    usageDate: localDateString(requestTime),
    credit,
    model: usageModel(row),
    client: safeText(row.client),
    agentPurpose: safeText(row.agentPurpose),
  };
}

async function fetchUsagePage(options) {
  const {
    accessToken,
    apiHost,
    startTime,
    endTime,
    pageNum,
    pageSize,
    fetchImpl,
    requestTimeoutMs,
  } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(`${apiHost}/billing/meter/get-user-request-usage`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'x-client-platform': 'web',
        origin: apiHost,
        referer: `${apiHost}/profile/plans-usage`,
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        startTime: formatLocalDateTime(startTime),
        endTime: formatLocalDateTime(endTime),
        pageNum,
        pageSize,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      throw new Error('官方用量接口返回了无法解析的数据');
    }
    if (!response.ok) throw new Error(`官方用量接口 HTTP ${response.status}`);
    if (payload.code !== 0 && payload.code !== undefined && payload.code !== null) {
      throw new Error(payload.msg || `官方用量接口 code=${payload.code}`);
    }
    const data = payload.data && typeof payload.data === 'object' ? payload.data : null;
    const total = data && Number(data.total);
    if (!data || !Number.isSafeInteger(total) || total < 0 || !Array.isArray(data.data)) {
      throw new Error('官方用量接口分页结构无效');
    }
    return { total, rows: data.data };
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('官方用量接口请求超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchUsageSinceAnchor(options = {}) {
  const accessToken = String(options.accessToken || '');
  const apiHost = String(options.apiHost || '').replace(/\/$/, '');
  const startTime = options.startTime instanceof Date ? options.startTime : null;
  const endTime = options.endTime instanceof Date ? options.endTime : null;
  const anchorRequestId = safeText(options.anchorRequestId, 512).trim();
  const pageSize = Number.isSafeInteger(options.pageSize) && options.pageSize > 0
    ? options.pageSize
    : DEFAULT_PAGE_SIZE;
  const maxPages = Number.isSafeInteger(options.maxPages) && options.maxPages > 0
    ? options.maxPages
    : DEFAULT_MAX_PAGES;
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
    ? Number(options.requestTimeoutMs)
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!accessToken || !apiHost || !startTime || !endTime || typeof fetchImpl !== 'function') {
    throw new Error('官方用量查询参数不完整');
  }
  if (startTime.getTime() > endTime.getTime()) throw new Error('官方用量查询时间范围无效');

  const records = [];
  let newestRequestId = '';
  let previousRequestTime = Infinity;
  let expectedTotal = null;
  let fetchedRows = 0;
  let reachedAnchor = false;

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const page = await fetchUsagePage({
      accessToken,
      apiHost,
      startTime,
      endTime,
      pageNum,
      pageSize,
      fetchImpl,
      requestTimeoutMs,
    });
    if (expectedTotal === null) expectedTotal = page.total;
    else if (page.total !== expectedTotal) throw new Error('官方用量接口分页总数发生变化');
    if (typeof options.onProgress === 'function') options.onProgress({
      page: pageNum, pages: Math.max(pageNum, Math.ceil(expectedTotal / pageSize)),
      records: fetchedRows + page.rows.length, total: expectedTotal,
    });
    if (!page.rows.length) {
      if (fetchedRows >= expectedTotal) {
        return { records, newestRequestId, total: expectedTotal, pages: pageNum, reachedAnchor };
      }
      throw new Error(`官方用量分页不完整: 已读取 ${fetchedRows}/${expectedTotal}`);
    }

    for (const raw of page.rows) {
      const record = normalizeUsageRow(raw);
      if (record.requestTime > previousRequestTime) {
        throw new Error('官方用量记录未按时间倒序返回');
      }
      previousRequestTime = record.requestTime;
      if (!newestRequestId) newestRequestId = record.requestId;
      if (anchorRequestId && record.requestId === anchorRequestId) {
        reachedAnchor = true;
        break;
      }
      records.push(record);
    }
    if (reachedAnchor) {
      return { records, newestRequestId, total: expectedTotal, pages: pageNum, reachedAnchor: true };
    }
    fetchedRows += page.rows.length;
    if (fetchedRows >= expectedTotal) {
      return { records, newestRequestId, total: expectedTotal, pages: pageNum, reachedAnchor: false };
    }
  }
  throw new Error(`官方用量分页不完整: 超过 ${maxPages} 页`);
}

// 全量扫描某账号的官方用量明细（累计全部）。
//
// 与 fetchUsageSinceAnchor 不同：后者信任服务端返回的 `total` 判断是否取完，
// 但 `get-user-request-usage` 会把 total 与单页数据一起截断到 pageSize（实测
// 恒为 3000），窗口内真实记录超过该值时 `total` 不可信，盲目信任会丢失超出
// 部分。这里改用 workbuddy-switch official_usage.rs 的「取满即推进起点」扫法：
// 每轮取满则说明区间内还有更多，把起点推进到本轮最新一条的时间戳（含边界去重）
// 继续，直到某一轮取不满为止——从而拿回窗口内的全量明细，不依赖被截断的 total。
async function fetchUsageFullScan(options = {}) {
  const accessToken = String(options.accessToken || '');
  const apiHost = String(options.apiHost || '').replace(/\/$/, '');
  const startTime = options.startTime instanceof Date ? options.startTime : null;
  const endTime = options.endTime instanceof Date ? options.endTime : null;
  const pageSize = Number.isSafeInteger(options.pageSize) && options.pageSize > 0
    ? options.pageSize
    : 3000;
  const maxRounds = Number.isSafeInteger(options.maxRounds) && options.maxRounds > 0
    ? options.maxRounds
    : 200;
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
    ? Number(options.requestTimeoutMs)
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!accessToken || !apiHost || !startTime || !endTime || typeof fetchImpl !== 'function') {
    throw new Error('官方用量全量扫描参数不完整');
  }
  if (startTime.getTime() > endTime.getTime()) throw new Error('官方用量查询时间范围无效');

  const records = [];
  const seen = new Set();
  let start = startTime;
  let previousNewest = null;
  let completedRounds = 0;
  for (let round = 1; round <= maxRounds; round++) {
    completedRounds = round;
    const page = await fetchUsagePage({
      accessToken,
      apiHost,
      startTime: start,
      endTime,
      pageNum: 1,
      pageSize,
      fetchImpl,
      requestTimeoutMs,
    });
    if (!page.rows.length) break;
    let newest = -Infinity;
    for (const raw of page.rows) {
      const record = normalizeUsageRow(raw);
      const dedupKey = `${record.requestId}@${record.requestTime}`;
      if (!seen.has(dedupKey)) {
        seen.add(dedupKey);
        records.push(record);
      }
      if (record.requestTime > newest) newest = record.requestTime;
    }
    if (page.rows.length < pageSize) break; // 没取满：区间内记录已取完
    if (!Number.isFinite(newest) || (previousNewest !== null && newest <= previousNewest)) {
      break; // 起点无法继续前进（记录挤在同一时间戳）：保活已取到数据，停止
    }
    start = new Date(newest + 1); // 含边界去重，从最新一条之后继续扫
    previousNewest = newest;
  }
  return { records, rounds: completedRounds };
}

module.exports = {
  fetchUsageSinceAnchor,
  fetchUsageFullScan,
  formatLocalDateTime,
  normalizeUsageRow,
  usageModel,
  parseRequestTime,
  startOfLocalDay,
};
