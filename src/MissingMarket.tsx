import { useEffect, useMemo, useRef, useState } from "react";
import { buildCatalog, collectNames, compareCatalog, type MarketGroup } from "./catalog";
import { readAssetTypes } from "./characterAssets";

function Icon({ id }: { id?: number }) {
  return id === undefined ? null : <img width="32" height="32" alt="" loading="lazy"
    src={`https://images.evetech.net/types/${id}/icon?size=32`} />;
}

function Branch({ group }: { group: MarketGroup }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  async function copy(language: "en" | "zh") {
    const { names, skipped } = collectNames(group, language);
    const label = language === "en" ? "英文" : "中文";
    if (!names.length) return setNotice(`没有可复制的${label}名称。`);
    try {
      await navigator.clipboard.writeText(names.join("\n"));
      setNotice(`已复制 ${names.length} 个${label}名称${skipped ? `，另有 ${skipped} 个缺少译名` : ""}。`);
    } catch {
      setNotice("复制失败，请允许浏览器访问剪贴板后重试。");
    }
  }
  return <li><div className="branch-row">
    <button type="button" className="branch-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span aria-hidden="true">{open ? "▾" : "▸"}</span><Icon id={group.icon} /> {group.name}
    </button>
    <div className="branch-actions">
      <button type="button" className="btn-copy" aria-label={`复制英文：${group.name}`} onClick={() => void copy("en")}>复制英文</button>
      <button type="button" className="btn-copy" aria-label={`复制中文：${group.name}`} onClick={() => void copy("zh")}>复制中文</button>
    </div>
  </div>
    <small className="copy-notice" role="status">{notice}</small>
    {open && <ul>
      {group.children.map(child => <Branch key={child.id} group={child} />)}
      {group.items.map(item => <li key={`type-${item.id}`}><Icon id={item.id} /> {item.name}</li>)}
      {!group.children.length && !group.items.length && <li>此目录为空</li>}
    </ul>}
  </li>;
}

export default function MissingMarket() {
  const [groups, setGroups] = useState<File>();
  const [types, setTypes] = useState<File>();
  const [roots, setRoots] = useState<MarketGroup[]>([]);
  const [status, setStatus] = useState("");
  const [assets, setAssets] = useState<Awaited<ReturnType<typeof readAssetTypes>>>();
  const [assetStatus, setAssetStatus] = useState("");
  const request = useRef<AbortController | null>(null);
  const tokenInput = useRef<HTMLInputElement>(null);
  const comparison = useMemo(() => assets && compareCatalog(roots, assets.owned), [roots, assets]);
  useEffect(() => () => request.current?.abort(), []);

  async function compare(raw: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setAssets(undefined);
    if (tokenInput.current) tokenInput.current.value = "";
    setAssetStatus("正在读取角色资产…");
    try {
      const result = await readAssetTypes(raw, controller.signal, (page, pages) => {
        if (!controller.signal.aborted) setAssetStatus(`已读取资产 ${page} / ${pages} 页`);
      });
      if (!controller.signal.aborted) {
        setAssets(result);
        setAssetStatus(`${result.character} 的资产已读取。`);
      }
    } catch (error) {
      if (!controller.signal.aborted) setAssetStatus(error instanceof TypeError ? "无法连接 ESI，请检查网络后重新粘贴令牌。" : String(error instanceof Error ? error.message : "资产读取失败。"));
    }
  }
  useEffect(() => {
    setRoots([]);
    setStatus("");
    if (!groups || !types) return;
    const controller = new AbortController();
    setStatus("正在读取市场目录…");
    buildCatalog(groups, types, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setRoots(result);
      setStatus(result.length ? "" : "文件中没有市场目录。");
    }).catch(error => {
      if (!controller.signal.aborted) setStatus(String(error.message ?? error));
    });
    return () => controller.abort();
  }, [groups, types]);
  return <main className="workspace missing-market"><section className="input-panel">
    <h2>我缺什么</h2>
    <p>选择两份 SDE 文件，在本地浏览市场目录。</p>
    <div className="catalog-files">
      <label>物品 · types.jsonl<input type="file" accept=".jsonl" onChange={e => setTypes(e.target.files?.[0])} /></label>
      <label>市场目录 · marketGroups.jsonl<input type="file" accept=".jsonl" onChange={e => setGroups(e.target.files?.[0])} /></label>
    </div>
    <p role="status">{status}</p>
    <form onSubmit={e => { e.preventDefault(); if (tokenInput.current?.value) void compare(tokenInput.current.value); }}>
      <label htmlFor="asset-token">角色 ESI 访问令牌</label>
      <p id="asset-help">粘贴后自动读取全部个人资产。令牌仅发送至 EVE 官方 ESI，需要 esi-assets.read_assets.v1 权限。</p>
      <input id="asset-token" type="password" ref={tokenInput} autoComplete="off" spellCheck={false}
        aria-describedby="asset-help" placeholder="粘贴访问令牌" onPaste={e => {
          const value = e.clipboardData.getData("text");
          if (value.trim()) { e.preventDefault(); void compare(value); }
        }} />
      <button type="submit" className="btn-primary">读取资产</button>
    </form>
    <p role="status">{assetStatus}</p>
    </section><section className="result-panel">
      <h2>{comparison ? "缺少的物品" : "市场目录"}</h2>
    {roots.length > 0 ? <>
      {comparison && <p>目录共 {comparison.total} 种，已拥有 {comparison.total - comparison.missing} 种，缺少 {comparison.missing} 种。</p>}
      <ul>{(comparison?.roots ?? roots).map(group => <Branch key={group.id} group={group} />)}</ul>
    </> : <p className="empty-chart">{status || "导入物品和市场目录文件后，即可展开目录。"}</p>}
  </section></main>;
}
