const scope = "esi-assets.read_assets.v1";

export async function readAssetTypes(raw: string, signal: AbortSignal, progress: (page: number, pages: number) => void) {
  const token = raw.trim().replace(/^Bearer\s+/i, "");
  let claims;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error();
    const binary = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
  } catch {
    throw new Error("无法识别令牌，请粘贴完整的 ESI 访问令牌。");
  }
  const id = /^CHARACTER:EVE:([1-9]\d*)$/.exec(claims?.sub)?.[1];
  if (!id) throw new Error("此令牌没有有效的角色 ID。");
  if (claims.exp <= Date.now() / 1000) throw new Error("令牌已过期，请粘贴新的访问令牌。");
  const scopes = Array.isArray(claims.scp) ? claims.scp : String(claims.scp ?? "").split(" ");
  if (!scopes.includes(scope)) throw new Error(`令牌缺少资产读取权限 ${scope}。`);

  const owned = new Set<number>();
  let pages = 1;
  let modified: string | null = null;
  for (let page = 1; page <= pages; page++) {
    const response = await fetch(`https://esi.evetech.net/latest/characters/${id}/assets/?page=${page}`, {
      headers: { Authorization: `Bearer ${token}` }, signal,
      credentials: "omit", redirect: "error", cache: "no-store",
    });
    if (response.status === 401 || response.status === 403) throw new Error("ESI 拒绝授权，请检查令牌有效期和资产读取权限。");
    if (!response.ok) throw new Error(`资产第 ${page} 页读取失败（HTTP ${response.status}），请稍后重新粘贴令牌。`);
    const total = Number(response.headers.get("X-Pages"));
    if (!Number.isSafeInteger(total) || total < 1) throw new Error("无法确认资产总页数，请稍后重试。");
    const timestamp = response.headers.get("Last-Modified");
    if (page > 1 && (pages !== total || timestamp !== modified)) throw new Error("资产在读取期间发生更新，请重新粘贴令牌。");
    pages = total;
    modified = timestamp;
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("ESI 返回的资产列表格式有误。");
    for (const row of rows) {
      if (!Number.isSafeInteger(row?.type_id) || row.type_id <= 0) throw new Error("资产记录缺少有效的物品类型。");
      owned.add(row.type_id);
    }
    progress(page, pages);
  }
  return { owned, character: typeof claims.name === "string" ? claims.name : id };
}
