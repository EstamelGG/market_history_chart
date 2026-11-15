type Item = { id: number; name: string };
export type MarketGroup = Item & {
  children: MarketGroup[];
  items: (Item & { en?: string; zh?: string })[];
  icon?: number;
};

export function collectNames(group: MarketGroup, language: "en" | "zh") {
  const names: string[] = [];
  let skipped = 0;
  function visit(branch: MarketGroup) {
    branch.children.forEach(visit);
    for (const item of branch.items) {
      const name = item[language]?.trim();
      if (name) names.push(name.replace(/[\r\n]+/g, " "));
      else skipped++;
    }
  }
  visit(group);
  return { names, skipped };
}

type RecordLine = {
  _key: number;
  name?: { zh?: string; en?: string };
  parentGroupID?: number;
  marketGroupID?: number;
};

export function compareCatalog(groups: MarketGroup[], owned: ReadonlySet<number>) {
  let total = 0, missing = 0;
  function filter(group: MarketGroup): MarketGroup[] {
    const items = group.items.filter(item => !owned.has(item.id));
    total += group.items.length;
    missing += items.length;
    const children = group.children.flatMap(filter);
    return items.length || children.length ? [{ ...group, children, items }] : [];
  }
  const roots = groups.flatMap(filter);
  return { roots, missing, total };
}

async function readLines(file: File, signal: AbortSignal, visit: (row: RecordLine) => void) {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  let line = 0;
  function parse(value: string) {
    line++;
    if (!value.trim()) return;
    try {
      const row = JSON.parse(value);
      if (!Number.isSafeInteger(row?._key)) throw new Error();
      visit(row);
    } catch {
      throw new Error(`${file.name} 第 ${line} 行格式有误，请检查 JSON 和 _key。`);
    }
  }
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (pending + value).split("\n");
      pending = lines.pop()!;
      lines.forEach(parse);
    }
    parse(pending);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function buildCatalog(groupsFile: File, typesFile: File, signal: AbortSignal) {
  const groups = new Map<number, MarketGroup>();
  const parents = new Map<number, number>();
  const roots: MarketGroup[] = [];
  const item = (row: RecordLine) => ({
    id: row._key, name: row.name?.zh || row.name?.en || String(row._key),
  });
  await readLines(groupsFile, signal, row => {
    if (groups.has(row._key)) throw new Error();
    groups.set(row._key, { ...item(row), children: [], items: [] });
    if (row.parentGroupID != null) parents.set(row._key, row.parentGroupID);
  });
  for (const group of groups.values()) {
    const parent = parents.get(group.id);
    const branch = parent === undefined ? undefined : groups.get(parent);
    (branch?.children ?? roots).push(group);
  }
  await readLines(typesFile, signal, row => {
    if (row.marketGroupID != null) groups.get(row.marketGroupID)?.items.push({
      ...item(row), en: row.name?.en, zh: row.name?.zh,
    });
  });
  let visited = 0;
  function assignIcon(group: MarketGroup) {
    visited++;
    group.icon = group.items[0]?.id;
    for (const child of group.children) {
      assignIcon(child);
      group.icon ??= child.icon;
    }
  }
  roots.forEach(assignIcon);
  if (visited !== groups.size) throw new Error("市场目录存在循环引用，请检查 parentGroupID。");
  return roots;
}
