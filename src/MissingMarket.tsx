import { useEffect, useState } from "react";
import { buildCatalog, type MarketGroup } from "./catalog";

function Icon({ id }: { id?: number }) {
  return id === undefined ? null : <img width="32" height="32" alt="" loading="lazy"
    src={`https://images.evetech.net/types/${id}/icon?size=32`} />;
}

function Branch({ group }: { group: MarketGroup }) {
  const [open, setOpen] = useState(false);
  return <li><details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Icon id={group.icon} /> {group.name}</summary>
    {open && <ul>
      {group.children.map(child => <Branch key={child.id} group={child} />)}
      {group.items.map(item => <li key={`type-${item.id}`}><Icon id={item.id} /> {item.name}</li>)}
      {!group.children.length && !group.items.length && <li>此目录为空</li>}
    </ul>}
  </details></li>;
}

export default function MissingMarket() {
  const [groups, setGroups] = useState<File>();
  const [types, setTypes] = useState<File>();
  const [roots, setRoots] = useState<MarketGroup[]>([]);
  const [status, setStatus] = useState("");
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
  return <section className="input-panel missing-market">
    <h2>我缺什么</h2>
    <p>选择两份 SDE 文件，在本地浏览市场目录。</p>
    <div className="catalog-files">
      <label>物品 · types.jsonl<input type="file" accept=".jsonl" onChange={e => setTypes(e.target.files?.[0])} /></label>
      <label>市场目录 · marketGroups.jsonl<input type="file" accept=".jsonl" onChange={e => setGroups(e.target.files?.[0])} /></label>
    </div>
    <p role="status">{status}</p>
    {roots.length > 0 && <><h3>市场目录</h3><ul>{roots.map(group => <Branch key={group.id} group={group} />)}</ul></>}
  </section>;
}
