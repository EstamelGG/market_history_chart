import { useCallback, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import "./App.css";
import {
  fetchMarketHistory,
  fetchUniverseIds,
  dateRangeEndingAtInclusive,
  formatIskDisplay,
  formatIskTotal,
  iconUrl,
  latestDateFromHistories,
  lineDataKey,
  lineIndexFromDataKey,
  mapPool,
  parseItemLines,
  resolveInventoryLines,
  type MissingLine,
  type ResolvedItem,
} from "./esi";

const HISTORY_DAYS = 360;
const FETCH_CONCURRENCY = 10;

const RANGE_POINTS = { "7d": 7, "30d": 30, "1y": 365 } as const;
type ChartRangeKey = keyof typeof RANGE_POINTS;

const LINE_COLORS = [
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

type TooltipPayloadEntry = {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
  color?: string;
  stroke?: string;
};

function ChartTooltip({
  active,
  label,
  payload,
  items,
}: {
  active?: boolean;
  label?: string | number;
  payload?: TooltipPayloadEntry[];
  items: ResolvedItem[];
}) {
  if (!active || !payload?.length) return null;

  const rows = [...payload]
    .map((entry) => ({
      entry,
      val: typeof entry.value === "number" ? entry.value : Number(entry.value),
    }))
    .sort((a, b) => {
      const av = Number.isFinite(a.val) ? a.val : -Infinity;
      const bv = Number.isFinite(b.val) ? b.val : -Infinity;
      return bv - av;
    });

  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-date">{label}</div>
      <ul className="chart-tooltip-list">
        {rows.map(({ entry }, i) => {
          const idx = lineIndexFromDataKey(entry.dataKey);
          const resolved = idx != null ? items.find((x) => x.lineIndex === idx) : undefined;
          const gIdx = resolved != null ? items.findIndex((x) => x.lineIndex === resolved.lineIndex) : -1;
          const strokeColor =
            entry.color ?? entry.stroke ?? (gIdx >= 0 ? LINE_COLORS[gIdx % LINE_COLORS.length] : "#888");
          return (
            <li key={`${String(entry.dataKey)}-${i}`} className="chart-tooltip-item">
              {resolved ? (
                <img className="chart-tooltip-icon" src={iconUrl(resolved.typeId)} alt="" loading="lazy" />
              ) : (
                <span className="chart-tooltip-icon chart-tooltip-icon--empty" aria-hidden />
              )}
              <span className="chart-tooltip-swatch" style={{ background: strokeColor }} aria-hidden />
              <span className="chart-tooltip-name" title={entry.name != null ? String(entry.name) : undefined}>
                {entry.name != null ? String(entry.name) : ""}
              </span>
              <span className="chart-tooltip-value">{formatIskDisplay(entry.value)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type ChartRow = Record<string, string | number>;

/** 图例悬停：多曲线时压低其余线透明度并加粗当前线；单选时仅加粗对应线 */
function lineEmphasis(
  lineIndex: number,
  filter: number | "all",
  hoverLine: number | null,
): { strokeOpacity: number; strokeWidth: number } {
  if (filter !== "all") {
    const onChart = lineIndex === filter;
    const hoverThis = hoverLine === lineIndex;
    if (onChart && hoverThis && hoverLine != null) {
      return { strokeOpacity: 1, strokeWidth: 3 };
    }
    return { strokeOpacity: 1, strokeWidth: 2 };
  }
  if (hoverLine == null) {
    return { strokeOpacity: 1, strokeWidth: 2 };
  }
  if (lineIndex === hoverLine) {
    return { strokeOpacity: 1, strokeWidth: 3 };
  }
  return { strokeOpacity: 0.18, strokeWidth: 2 };
}

function buildChartRows(
  dates: string[],
  items: ResolvedItem[],
  historyByType: Map<number, Map<string, number>>,
): ChartRow[] {
  return dates.map((date) => {
    const row: ChartRow = { date };
    for (const it of items) {
      const m = historyByType.get(it.typeId);
      const avg = m?.get(date);
      const v = avg !== undefined ? avg * it.quantity : 0;
      row[lineDataKey(it.lineIndex)] = v;
    }
    return row;
  });
}

export default function App() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ResolvedItem[]>([]);
  const [chartData, setChartData] = useState<ChartRow[]>([]);
  const [missingModal, setMissingModal] = useState<MissingLine[] | null>(null);
  const [filter, setFilter] = useState<number | "all">("all");
  const [chartRange, setChartRange] = useState<ChartRangeKey>("1y");
  const [legendHoverLine, setLegendHoverLine] = useState<number | null>(null);

  const displayChartData = useMemo(() => {
    if (chartData.length === 0) return [];
    const take = RANGE_POINTS[chartRange];
    return chartData.slice(-Math.min(take, chartData.length));
  }, [chartData, chartRange]);

  const displayRangeLabel = useMemo(() => {
    if (displayChartData.length === 0) return "—";
    const a = String(displayChartData[0].date);
    const b = String(displayChartData[displayChartData.length - 1].date);
    return `${a} — ${b} · Jita (The Forge)`;
  }, [displayChartData]);

  const load = useCallback(async () => {
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
        setItems([]);
        setChartData([]);
        setLoading(false);
        return;
      }

      const typeIds = [...new Set(resolved.map((r) => r.typeId))];
      const histories = await mapPool(typeIds, FETCH_CONCURRENCY, (tid) => fetchMarketHistory(tid));

      const anchorEnd = latestDateFromHistories(histories);
      if (anchorEnd == null) {
        setError("无行情数据。");
        setItems([]);
        setChartData([]);
        setLoading(false);
        return;
      }

      const dates = dateRangeEndingAtInclusive(anchorEnd, HISTORY_DAYS);
      if (dates.length === 0) {
        setError("日期解析失败。");
        setItems([]);
        setChartData([]);
        setLoading(false);
        return;
      }

      const dateSet = new Set(dates);
      const historyByType = new Map<number, Map<string, number>>();

      typeIds.forEach((tid, i) => {
        const pts = histories[i];
        const m = new Map<string, number>();
        for (const pt of pts) {
          if (dateSet.has(pt.date)) {
            m.set(pt.date, pt.average);
          }
        }
        historyByType.set(tid, m);
      });

      const rows = buildChartRows(dates, resolved, historyByType);
      setItems(resolved);
      setChartData(rows);
      setChartRange("1y");
      setFilter("all");
      setLegendHoverLine(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [text]);

  const visibleItems = useMemo(() => {
    if (filter === "all") return items;
    return items.filter((x) => x.lineIndex === filter);
  }, [filter, items]);

  /** 「全部」且悬停某条时，把该曲线最后绘制以便压在其它线之上 */
  const linesToRender = useMemo(() => {
    if (filter !== "all" || legendHoverLine == null) return visibleItems;
    const hit = visibleItems.find((x) => x.lineIndex === legendHoverLine);
    const rest = visibleItems.filter((x) => x.lineIndex !== legendHoverLine);
    if (!hit) return visibleItems;
    return [...rest, hit];
  }, [visibleItems, filter, legendHoverLine]);

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">EVE 市场历史曲线</h1>
        <p className="app-sub">英文物品名 · Jita · 数量×日均价</p>
      </header>

      <section className="input-panel">
        <label className="input-label" htmlFor="items-input">
          物品列表
        </label>
        <textarea
          id="items-input"
          className="item-textarea"
          placeholder={"名称\t数量\nEnriched Uranium\t4"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
        <div className="toolbar">
          <button type="button" className="btn-primary" disabled={loading} onClick={() => void load()}>
            {loading ? "加载中…" : "解析并绘制"}
          </button>
          <span className="hint">
            最晚日锚定 · {HISTORY_DAYS} 天 · 上图切范围 · 缺日 0 · 同名合并
          </span>
        </div>
        {error ? <div className="err">{error}</div> : null}
      </section>

      <section className="chart-section">
        <div className="chart-head">
          <div>
            <h2 className="chart-title">总价值（ISK）</h2>
            <p className="chart-meta">{displayRangeLabel}</p>
          </div>
          {items.length > 0 ? (
            <div className="range-toggle" role="group" aria-label="时间范围">
              {(
                [
                  ["7d", "近7天"],
                  ["30d", "近1月"],
                  ["1y", "近1年"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`legend-btn${chartRange === key ? " active" : ""}`}
                  onClick={() => setChartRange(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {items.length > 0 ? (
          <div
            className="legend-row"
            style={{ marginBottom: "0.65rem" }}
            onPointerLeave={() => setLegendHoverLine(null)}
          >
            <button
              type="button"
              className={`legend-btn${filter === "all" ? " active" : ""}`}
              onClick={() => {
                setFilter("all");
                setLegendHoverLine(null);
              }}
              onPointerEnter={() => setLegendHoverLine(null)}
            >
              全部
            </button>
            {items.map((it, idx) => (
              <button
                key={it.lineIndex}
                type="button"
                className={`legend-btn${filter === it.lineIndex ? " active" : ""}`}
                onClick={() => {
                  setFilter(it.lineIndex);
                  setLegendHoverLine(null);
                }}
                onPointerEnter={() => setLegendHoverLine(it.lineIndex)}
              >
                <img className="legend-icon" src={iconUrl(it.typeId)} alt="" loading="lazy" />
                <span>{it.displayName}</span>
                <span style={{ opacity: 0.75 }}>×{it.quantity}</span>
                <span style={{ opacity: 0.65 }}>({it.typeId})</span>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: LINE_COLORS[idx % LINE_COLORS.length],
                  }}
                />
              </button>
            ))}
          </div>
        ) : null}

        {items.length === 0 && !loading ? (
          <div className="empty-chart">暂无数据</div>
        ) : (
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={displayChartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--grid)" strokeDasharray="3 6" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "var(--text-muted)", fontSize: 10 }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                  minTickGap={32}
                  tickFormatter={(v) => String(v).slice(5)}
                />
                <YAxis
                  tick={{ fill: "var(--text-muted)", fontSize: 10 }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                  tickFormatter={(v) => formatIskTotal(typeof v === "number" ? v : Number(v))}
                  width={72}
                />
                <Tooltip
                  cursor={{ stroke: "var(--border-glow)", strokeWidth: 1, strokeDasharray: "4 4" }}
                  content={(props) => (
                    <ChartTooltip
                      active={props.active}
                      label={props.label}
                      payload={props.payload as TooltipPayloadEntry[] | undefined}
                      items={items}
                    />
                  )}
                />
                {linesToRender.map((it, idx) => {
                  const globalIdx = items.findIndex((x) => x.lineIndex === it.lineIndex);
                  const color = LINE_COLORS[(globalIdx >= 0 ? globalIdx : idx) % LINE_COLORS.length];
                  const { strokeOpacity, strokeWidth } = lineEmphasis(it.lineIndex, filter, legendHoverLine);
                  return (
                    <Line
                      key={it.lineIndex}
                      type="monotone"
                      dataKey={lineDataKey(it.lineIndex)}
                      name={`${it.displayName} ×${it.quantity}`}
                      stroke={color}
                      strokeOpacity={strokeOpacity}
                      dot={false}
                      strokeWidth={strokeWidth}
                      isAnimationActive={false}
                    />
                  );
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {missingModal ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setMissingModal(null)}>
          <div className="modal" role="dialog" aria-labelledby="missing-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="missing-title">未解析</h2>
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
    </div>
  );
}
