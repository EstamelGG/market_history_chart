import { useCallback, useMemo, useState } from "react";
import {
  fetchPricesViaEsi,
  fetchUniverseIds,
  formatIskFull,
  formatIskTotal,
  iconUrl,
  JITA_SYSTEM_ID,
  parseItemLines,
  resolveInventoryLines,
  type MarketPrice,
  type MissingLine,
  type ResolvedItem,
} from "./esi";

const FETCH_CONCURRENCY = 10;

/** 分布条彩色段配色（累计 ≥70% 的物品各分一色） */
const DIST_COLORS = [
  "#3dff9c",
  "#22d3ee",
  "#fbbf24",
  "#f472b6",
  "#a78bfa",
  "#fb923c",
  "#4ade80",
  "#38bdf8",
  "#f87171",
  "#c084fc",
  "#2dd4bf",
  "#fcd34d",
];

const DISTRIBUTION_THRESHOLD = 0.7;

type EstimatedItem = ResolvedItem & {
  price: MarketPrice | null;
};

type EstimateResult = {
  items: EstimatedItem[];
  totalBuy: number;
  totalSell: number;
  totalMid: number;
};

/** 中间价：双边都有取均值，仅单边则取该边，均无则 null */
function midPrice(p: MarketPrice | null): number | null {
  if (!p) return null;
  if (p.b != null && p.s != null) return (p.b + p.s) / 2;
  if (p.b != null) return p.b;
  if (p.s != null) return p.s;
  return null;
}

type DistSegment = {
  typeId: number;
  name: string;
  value: number;
  pct: number;
  color: string;
};

type Distribution = {
  segments: DistSegment[];
  other: { value: number; pct: number } | null;
  total: number;
};

type SortKey =
  | "name"
  | "typeId"
  | "quantity"
  | "buyUnit"
  | "sellUnit"
  | "midUnit"
  | "buySub"
  | "sellSub"
  | "midSub";

type SortState = { key: SortKey; dir: "asc" | "desc" } | null;

/** 排序取值；无价格视为 0 */
function sortValue(it: EstimatedItem, key: SortKey): number | string {
  const mid = midPrice(it.price);
  switch (key) {
    case "name":
      return it.displayName.toLowerCase();
    case "typeId":
      return it.typeId;
    case "quantity":
      return it.quantity;
    case "buyUnit":
      return it.price?.b ?? 0;
    case "sellUnit":
      return it.price?.s ?? 0;
    case "midUnit":
      return mid ?? 0;
    case "buySub":
      return (it.price?.b ?? 0) * it.quantity;
    case "sellSub":
      return (it.price?.s ?? 0) * it.quantity;
    case "midSub":
      return (mid ?? 0) * it.quantity;
  }
}

/** 按指定价值降序排列，累计达 70% 前的物品各自一色，其余合并为「其他」 */
function buildDistribution(
  items: EstimatedItem[],
  getValue: (it: EstimatedItem) => number,
): Distribution {
  const valued = items
    .map((it) => ({ it, value: getValue(it) }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value);

  const total = valued.reduce((s, x) => s + x.value, 0);
  if (total === 0) return { segments: [], other: null, total: 0 };

  const segments: DistSegment[] = [];
  let cumulative = 0;
  let otherValue = 0;

  for (const x of valued) {
    const pct = x.value / total;
    if (cumulative < DISTRIBUTION_THRESHOLD) {
      segments.push({
        typeId: x.it.typeId,
        name: x.it.displayName,
        value: x.value,
        pct,
        color: DIST_COLORS[segments.length % DIST_COLORS.length],
      });
      cumulative += pct;
    } else {
      otherValue += x.value;
    }
  }

  const other = otherValue > 0 ? { value: otherValue, pct: otherValue / total } : null;
  return { segments, other, total };
}

export default function MarketEstimate() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EstimateResult | null>(null);
  const [missingModal, setMissingModal] = useState<MissingLine[] | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{
    typeId?: number;
    name: string;
    value: number;
    pct: number;
  } | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [sortState, setSortState] = useState<SortState>(null);
  const [copied, setCopied] = useState(false);
  const [jitaOnly, setJitaOnly] = useState(false);

  const estimate = useCallback(async () => {
    setError(null);
    const lines = parseItemLines(text);
    if (lines.length === 0) {
      setError("请粘贴物品列表（英文名称，Tab 分隔数量可选）。");
      return;
    }

    setLoading(true);
    try {
      const uniqueNames = [...new Set(lines.map((l) => l.name))];
      const idsJson = await fetchUniverseIds(uniqueNames);
      const inv = idsJson.inventory_types ?? [];
      const { resolved, missing } = resolveInventoryLines(lines, inv);

      if (missing.length > 0) {
        setMissingModal(missing);
      }

      if (resolved.length === 0) {
        setResult(null);
        setLoading(false);
        return;
      }

      const typeIds = [...new Set(resolved.map((r) => r.typeId))];
      const esiPrices = await fetchPricesViaEsi(typeIds, FETCH_CONCURRENCY, (done, total) => {
        setProgress({ done, total });
      }, jitaOnly ? JITA_SYSTEM_ID : undefined);

      const items: EstimatedItem[] = resolved.map((r) => ({
        ...r,
        price: esiPrices.get(r.typeId) ?? null,
      }));

      let totalBuy = 0;
      let totalSell = 0;
      let totalMid = 0;
      for (const it of items) {
        const mid = midPrice(it.price);
        if (it.price?.b != null) totalBuy += it.quantity * it.price.b;
        if (it.price?.s != null) totalSell += it.quantity * it.price.s;
        if (mid != null) totalMid += it.quantity * mid;
      }

      setResult({ items, totalBuy, totalSell, totalMid });
      setSortState(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }, [text, jitaOnly]);

  const distBuy = useMemo(
    () => (result ? buildDistribution(result.items, (it) => (it.price?.b ?? 0) * it.quantity) : null),
    [result],
  );
  const distSell = useMemo(
    () => (result ? buildDistribution(result.items, (it) => (it.price?.s ?? 0) * it.quantity) : null),
    [result],
  );

  const missingBuy = result?.items.filter((it) => it.price?.b == null).length ?? 0;
  const missingSell = result?.items.filter((it) => it.price?.s == null).length ?? 0;
  const missingMid = result?.items.filter((it) => midPrice(it.price) == null).length ?? 0;

  const sortedItems = useMemo(() => {
    if (!result) return [];
    if (!sortState) return result.items;
    const items = [...result.items];
    const dir = sortState.dir === "asc" ? 1 : -1;
    items.sort((a, b) => {
      const va = sortValue(a, sortState.key);
      const vb = sortValue(b, sortState.key);
      if (typeof va === "string" && typeof vb === "string") {
        return va < vb ? -dir : va > vb ? dir : 0;
      }
      return ((va as number) - (vb as number)) * dir;
    });
    return items;
  }, [result, sortState]);

  const handleSort = useCallback((key: SortKey) => {
    setSortState((prev) => {
      if (prev?.key !== key) {
        return { key, dir: key === "name" ? "asc" : "desc" };
      }
      return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  }, []);

  const handleCopy = useCallback(() => {
    if (!result) return;
    const headers = [
      "物品",
      "TypeID",
      "数量",
      "买价(单价)",
      "卖价(单价)",
      "中间价(单价)",
      "买价小计",
      "卖价小计",
      "中间价小计",
    ];
    const rows = sortedItems.map((it) => {
      const mid = midPrice(it.price);
      const b = it.price?.b ?? 0;
      const s = it.price?.s ?? 0;
      const m = mid ?? 0;
      return [
        it.displayName,
        it.typeId,
        it.quantity,
        b,
        s,
        m,
        b * it.quantity,
        s * it.quantity,
        m * it.quantity,
      ].join("\t");
    });
    const tsv = [headers.join("\t"), ...rows].join("\n");
    navigator.clipboard.writeText(tsv).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [result, sortedItems]);

  const thSortClass = (key: SortKey): string =>
    !sortState || sortState.key !== key ? "th-sort" : `th-sort active ${sortState.dir}`;

  const renderDistribution = (title: string, dist: Distribution | null) => {
    if (!dist || dist.total === 0) return null;
    return (
      <div className="dist-panel">
        <div className="dist-head">
          <h3 className="dist-title">{title}</h3>
        </div>
        <div
          className="dist-bar"
          role="img"
          aria-label={title}
          onMouseMove={(e) => setMousePos({ x: e.clientX, y: e.clientY })}
          onMouseLeave={() => setHoverInfo(null)}
        >
          {dist.segments.map((seg) => (
            <div
              key={seg.typeId}
              className="dist-seg"
              style={{ flexGrow: seg.pct, background: seg.color }}
              onMouseEnter={() =>
                setHoverInfo({ typeId: seg.typeId, name: seg.name, value: seg.value, pct: seg.pct })
              }
            />
          ))}
          {dist.other ? (
            <div
              className="dist-seg dist-seg--other"
              style={{ flexGrow: dist.other.pct }}
              onMouseEnter={() =>
                setHoverInfo({
                  name: "其他",
                  value: dist.other!.value,
                  pct: dist.other!.pct,
                })
              }
            />
          ) : null}
        </div>
        <div className="dist-legend">
          {dist.segments.map((seg) => (
            <div key={seg.typeId} className="dist-legend-item">
              <span className="dist-swatch" style={{ background: seg.color }} />
              <img className="dist-legend-icon" src={iconUrl(seg.typeId)} alt="" loading="lazy" />
              <span className="dist-legend-name" title={seg.name}>{seg.name}</span>
              <span className="dist-legend-pct">{(seg.pct * 100).toFixed(1)}%</span>
              <span className="dist-legend-value">{formatIskTotal(seg.value)}</span>
            </div>
          ))}
          {dist.other ? (
            <div className="dist-legend-item">
              <span className="dist-swatch dist-swatch--other" />
              <span className="dist-legend-name">其他</span>
              <span className="dist-legend-pct">{(dist.other.pct * 100).toFixed(1)}%</span>
              <span className="dist-legend-value">{formatIskTotal(dist.other.value)}</span>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <>
      <section className="input-panel">
        <label className="input-label" htmlFor="estimate-input">
          物品列表
        </label>
        <textarea
          id="estimate-input"
          className="item-textarea"
          placeholder={"名称\t数量\nEnriched Uranium\t4"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
        <div className="toolbar">
          <button type="button" className="btn-primary" disabled={loading} onClick={() => void estimate()}>
            {loading && progress
              ? `估算中… ${progress.done}/${progress.total}`
              : loading
                ? "估算中…"
                : "估算总价"}
          </button>
          <label className="checkbox-inline">
            <input type="checkbox" checked={jitaOnly} onChange={(e) => setJitaOnly(e.target.checked)} />
            只看 Jita
          </label>
        </div>
        {error ? <div className="err">{error}</div> : null}
      </section>

      {result ? (
        <section className="estimate-section">
          <div className="estimate-summary">
            <div className="estimate-card estimate-card--buy">
              <div className="estimate-card-label">买价总价</div>
              <div className="estimate-card-value">{formatIskTotal(result.totalBuy)}</div>
              <div className="estimate-card-sub">{formatIskFull(result.totalBuy)} ISK</div>
              {missingBuy > 0 ? <div className="estimate-card-warn">{missingBuy} 个物品缺少买价</div> : null}
            </div>
            <div className="estimate-card estimate-card--mid">
              <div className="estimate-card-label">中间价总价</div>
              <div className="estimate-card-value">{formatIskTotal(result.totalMid)}</div>
              <div className="estimate-card-sub">{formatIskFull(result.totalMid)} ISK</div>
              {missingMid > 0 ? <div className="estimate-card-warn">{missingMid} 个物品缺少价格</div> : null}
            </div>
            <div className="estimate-card estimate-card--sell">
              <div className="estimate-card-label">卖价总价</div>
              <div className="estimate-card-value">{formatIskTotal(result.totalSell)}</div>
              <div className="estimate-card-sub">{formatIskFull(result.totalSell)} ISK</div>
              {missingSell > 0 ? <div className="estimate-card-warn">{missingSell} 个物品缺少卖价</div> : null}
            </div>
          </div>

          {renderDistribution("买价分布", distBuy)}
          {renderDistribution("卖价分布", distSell)}

          {hoverInfo ? (
            <div
              className="dist-tooltip"
              style={{
                left: mousePos.x > window.innerWidth - 280 ? mousePos.x - 14 : mousePos.x + 14,
                top: mousePos.y + 14,
                transform: mousePos.x > window.innerWidth - 280 ? "translateX(-100%)" : undefined,
              }}
            >
              {hoverInfo.typeId != null ? (
                <img className="dist-tooltip-icon" src={iconUrl(hoverInfo.typeId)} alt="" />
              ) : null}
              <span className="dist-tooltip-name">{hoverInfo.name}</span>
              <span className="dist-tooltip-value">{formatIskFull(hoverInfo.value)} ISK</span>
              <span className="dist-tooltip-pct">{(hoverInfo.pct * 100).toFixed(1)}%</span>
            </div>
          ) : null}

          <div className="estimate-table-toolbar">
            <button type="button" className="btn-copy" onClick={handleCopy}>
              {copied ? "已复制" : "复制表格"}
            </button>
          </div>

          <div className="estimate-table-wrap">
            <table className="estimate-table">
              <thead>
                <tr>
                  <th className={thSortClass("name")} onClick={() => handleSort("name")}>物品</th>
                  <th className={thSortClass("typeId")} style={{ textAlign: "right" }} onClick={() => handleSort("typeId")}>TypeID</th>
                  <th className={thSortClass("quantity")} style={{ textAlign: "right" }} onClick={() => handleSort("quantity")}>数量</th>
                  <th className={thSortClass("buyUnit")} style={{ textAlign: "right" }} onClick={() => handleSort("buyUnit")}>买价（单价）</th>
                  <th className={thSortClass("sellUnit")} style={{ textAlign: "right" }} onClick={() => handleSort("sellUnit")}>卖价（单价）</th>
                  <th className={thSortClass("midUnit")} style={{ textAlign: "right" }} onClick={() => handleSort("midUnit")}>中间价（单价）</th>
                  <th className={thSortClass("buySub")} style={{ textAlign: "right" }} onClick={() => handleSort("buySub")}>买价小计</th>
                  <th className={thSortClass("sellSub")} style={{ textAlign: "right" }} onClick={() => handleSort("sellSub")}>卖价小计</th>
                  <th className={thSortClass("midSub")} style={{ textAlign: "right" }} onClick={() => handleSort("midSub")}>中间价小计</th>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((it) => {
                  const mid = midPrice(it.price);
                  return (
                    <tr key={it.typeId}>
                      <td className="estimate-cell-name">
                        <img className="legend-icon" src={iconUrl(it.typeId)} alt="" loading="lazy" />
                        <span>{it.displayName}</span>
                      </td>
                      <td className="estimate-cell-num">{it.typeId}</td>
                      <td className="estimate-cell-num">{it.quantity.toLocaleString("en-US")}</td>
                      <td className="estimate-cell-num">
                        {it.price?.b != null ? formatIskFull(it.price.b) : "—"}
                      </td>
                      <td className="estimate-cell-num">
                        {it.price?.s != null ? formatIskFull(it.price.s) : "—"}
                      </td>
                      <td className="estimate-cell-num">
                        {mid != null ? formatIskFull(mid) : "—"}
                      </td>
                      <td className="estimate-cell-num">
                        {it.price?.b != null ? formatIskFull(it.price.b * it.quantity) : "—"}
                      </td>
                      <td className="estimate-cell-num">
                        {it.price?.s != null ? formatIskFull(it.price.s * it.quantity) : "—"}
                      </td>
                      <td className="estimate-cell-num">
                        {mid != null ? formatIskFull(mid * it.quantity) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {missingModal ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setMissingModal(null)}>
          <div
            className="modal"
            role="dialog"
            aria-labelledby="estimate-missing-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="estimate-missing-title">未解析</h2>
            <p className="chart-meta" style={{ marginBottom: "0.75rem" }}>
              请使用英文名称核对拼写。
            </p>
            <ul>
              {missingModal.map((m, i) => (
                <li key={`${m.name}-${m.quantity}-${i}`}>
                  {m.name}
                  <span style={{ opacity: 0.75 }}>（数量 {m.quantity}）</span>
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button type="button" className="btn-primary" onClick={() => setMissingModal(null)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
