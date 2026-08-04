export const ESI_BASE = "https://esi.evetech.net";

const REGION_FORGE = 10000002;

/** 第二列为数量：支持千位逗号；解析失败或非正数时视为 1 */
export function parseQuantity(raw: string | undefined): number {
  if (raw == null) return 1;
  const s = raw.replace(/,/g, "").trim();
  if (!s) return 1;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
}

export type ParsedLine = {
  name: string;
  quantity: number;
};

/**
 * 解析多行；**同名合并**：英文名称按不区分大小写合并，数量相加；展示名取首次出现的写法。
 */
export function parseItemLines(raw: string): ParsedLine[] {
  const lines = raw.split(/\r?\n/);
  const order: string[] = [];
  const qtyByKey = new Map<string, number>();
  const displayByKey = new Map<string, string>();

  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const name = (parts[0] ?? "").trim();
    if (!name) continue;
    const q = parseQuantity(parts[1]);
    const key = name.toLowerCase();
    if (!qtyByKey.has(key)) {
      order.push(key);
      displayByKey.set(key, name);
      qtyByKey.set(key, q);
    } else {
      qtyByKey.set(key, (qtyByKey.get(key) ?? 0) + q);
    }
  }

  return order.map((key) => ({
    name: displayByKey.get(key)!,
    quantity: qtyByKey.get(key)!,
  }));
}

export function namesMatch(apiName: string, userName: string): boolean {
  const a = apiName.trim();
  const u = userName.trim();
  if (a === u) return true;
  if (a.toLowerCase() === u.toLowerCase()) return true;
  return false;
}

export type InventoryType = { id: number; name: string };

export type IdsResponse = {
  inventory_types?: InventoryType[];
  corporations?: { id: number; name: string }[];
};

export async function fetchUniverseIds(names: string[]): Promise<IdsResponse> {
  const res = await fetch(`${ESI_BASE}/universe/ids?category=inventory_types`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Accept-Language": "en",
    },
    body: JSON.stringify(names),
  });
  if (!res.ok) {
    throw new Error(`universe/ids ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<IdsResponse>;
}

export type HistoryPoint = {
  average: number;
  date: string;
};

export async function fetchMarketHistory(typeId: number): Promise<HistoryPoint[]> {
  const url = `${ESI_BASE}/markets/${REGION_FORGE}/history?type_id=${typeId}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`history ${typeId}: ${res.status}`);
  }
  return res.json() as Promise<HistoryPoint[]>;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatUtcDay(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** `YYYY-MM-DD` 字符串取最大（字典序即时间序） */
export function maxIsoDate(dates: string[]): string | null {
  if (dates.length === 0) return null;
  return dates.reduce((a, b) => (a >= b ? a : b));
}

/** 合并所有物品的 history，取其中出现的最晚一个 `date` 作为横轴右端锚点 */
export function latestDateFromHistories(histories: { date: string }[][]): string | null {
  const all: string[] = [];
  for (const pts of histories) {
    for (const pt of pts) {
      all.push(pt.date);
    }
  }
  return maxIsoDate(all);
}

/**
 * 以 `endInclusiveIso`（含）为最后一天，向前共 `dayCount` 个日历日（UTC），升序。
 * `endInclusiveIso` 须为 `YYYY-MM-DD`（与 ESI 一致）。
 */
export function dateRangeEndingAtInclusive(endInclusiveIso: string, dayCount: number): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endInclusiveIso.trim());
  if (!m) return [];
  const endUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const msPerDay = 86_400_000;
  const out: string[] = [];
  for (let i = dayCount - 1; i >= 0; i--) {
    const t = endUtc - i * msPerDay;
    out.push(formatUtcDay(new Date(t)));
  }
  return out;
}

export type ResolvedItem = {
  /** 在列表中的序号，用于图表 dataKey（同名、同 type 也可区分多条曲线） */
  lineIndex: number;
  typeId: number;
  displayName: string;
  apiName: string;
  quantity: number;
};

export type MissingLine = { name: string; quantity: number };

export function resolveInventoryLines(
  lines: ParsedLine[],
  inventoryTypes: InventoryType[],
): { resolved: ResolvedItem[]; missing: MissingLine[] } {
  const resolved: ResolvedItem[] = [];
  const missing: MissingLine[] = [];
  lines.forEach((line, lineIndex) => {
    const t = inventoryTypes.find((x) => namesMatch(x.name, line.name));
    if (t) {
      resolved.push({
        lineIndex,
        typeId: t.id,
        displayName: line.name,
        apiName: t.name,
        quantity: line.quantity,
      });
    } else {
      missing.push({ name: line.name, quantity: line.quantity });
    }
  });
  return { resolved, missing };
}

export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results: R[] = new Array(n);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= n) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, n) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * 总价（ISK）：固定 2 位小数；自 1e3 起使用 K / M / B / T（10³ / 10⁶ / 10⁹ / 10¹²）。
 */
export function formatIskTotal(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs === 0) return "0.00";
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

export function formatIskDisplay(value: number | string | undefined): string {
  if (value === undefined) return "—";
  const n = typeof value === "number" ? value : Number(value);
  return formatIskTotal(n);
}

export function iconUrl(typeId: number): string {
  return `https://images.evetech.net/types/${typeId}/icon`;
}

export function lineDataKey(lineIndex: number): string {
  return `l_${lineIndex}`;
}

/** 与 {@link lineDataKey} 对应，解析失败返回 `null` */
export function lineIndexFromDataKey(dataKey: string | number | undefined): number | null {
  if (dataKey == null) return null;
  const m = /^l_(\d+)$/.exec(String(dataKey));
  if (!m) return null;
  return Number(m[1]);
}

// ===== 市场估价 =====

/** 买价（最高买单）与售价（最低卖单）；某侧无订单则为 null */
export type MarketPrice = { b: number | null; s: number | null };

export type MarketOrder = {
  is_buy_order: boolean;
  price: number;
  type_id: number;
};

/** 获取某 type_id 在 The Forge 的市场订单（自动翻页） */
export async function fetchMarketOrders(typeId: number): Promise<MarketOrder[]> {
  const all: MarketOrder[] = [];
  let page = 1;
  let pages = 1;
  do {
    const url = `${ESI_BASE}/markets/${REGION_FORGE}/orders?type_id=${typeId}&page=${page}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`orders ${typeId} page ${page}: ${res.status}`);
    }
    const data = (await res.json()) as MarketOrder[];
    all.push(...data);
    const xPages = res.headers.get("X-Pages");
    pages = xPages ? Number(xPages) : 1;
    page++;
  } while (page <= pages);
  return all;
}

/** 从订单列表计算买价（最高买单）与售价（最低卖单）；无对应订单则该侧为 null */
export function computePricesFromOrders(orders: MarketOrder[]): MarketPrice {
  let b: number | null = null;
  let s: number | null = null;
  for (const o of orders) {
    if (o.is_buy_order) {
      if (b === null || o.price > b) b = o.price;
    } else {
      if (s === null || o.price < s) s = o.price;
    }
  }
  return { b, s };
}

/** 并发获取多个 type_id 的市场估价（ESI 订单）；失败的 type 跳过 */
export async function fetchPricesViaEsi(
  typeIds: number[],
  concurrency: number,
): Promise<Map<number, MarketPrice>> {
  const results = await mapPool(typeIds, concurrency, async (tid) => {
    try {
      const orders = await fetchMarketOrders(tid);
      return [tid, computePricesFromOrders(orders)] as const;
    } catch {
      return [tid, null] as const;
    }
  });
  const map = new Map<number, MarketPrice>();
  for (const [tid, p] of results) {
    if (p) map.set(tid, p);
  }
  return map;
}

/** 完整 ISK 数字（千位逗号），用于估价明细 */
export function formatIskFull(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}
