import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getResourceDef } from '@kudesi/shared';
import { resourceApi } from './api';
import { ArchiveHome, useHierTabs } from './ArchiveHome';
import { ResourcePage, type HierContext } from './ResourcePage';

/**
 * 财务基础资料四档（商品、供应商、客户、费用）的分级布局：先是顶级分类卡片，点进去是“左侧分类树 + 右侧列表”。
 * 进入哪一个顶级记在地址里（?g=），刷新、后退都能回到原处。配置在资料定义的 hierarchy 上，四档共用这一套。
 */
export function HierarchyPage({ type }: { type: string }) {
  const def = getResourceDef(type)!;
  const cfg = def.hierarchy!;
  const [params, setParams] = useSearchParams();
  const g = params.get('g') ?? '';
  const tabs = useHierTabs(def);
  const [rootTitle, setRootTitle] = useState<{ id: string; title: string; subtitle: string } | null>(null);
  const [entry, setEntry] = useState<{ key: string; title: string; subtitle: string } | null>(null);
  const go = (key: string, e?: { title: string; subtitle: string }) => { if (e) setEntry({ key, ...e }); setParams((p) => { const n = new URLSearchParams(p); if (key) n.set('g', key); else n.delete('g'); n.delete('open'); return n; }); };

  // 刷新进来时地址里只有 id：补查顶级分类的名称和说明
  useEffect(() => {
    if (cfg.kind !== 'category' || !g || g === 'all' || !cfg.categoryType || entry?.key === g) return;
    let alive = true;
    resourceApi.get(cfg.categoryType, Number(g)).then((r) => { if (alive) setRootTitle({ id: g, title: r.title, subtitle: String(r.data.subtitle ?? '') }); }).catch(() => { if (alive) setRootTitle({ id: g, title: '分类', subtitle: '' }); });
    return () => { alive = false; };
  }, [g, cfg.kind, cfg.categoryType, entry?.key]);

  if (!g) return <ArchiveHome type={type} onEnter={(e) => go(e.key, e)} />;
  const back = () => go('');
  if (cfg.kind === 'tab') {
    const tab = tabs.find((t) => t.value === g);
    return <ResourcePage key={g} type={type} lockedTab={g} hier={{ title: tab?.label ?? entry?.title ?? def.label, subtitle: entry?.subtitle ?? cfg.subtitle, onBack: back }} />;
  }
  if (g === 'all') return <ResourcePage key="all" type={type} hier={{ title: `全部${def.label.replace('档案', '')}`, subtitle: cfg.subtitle, onBack: back }} />;
  const known = entry?.key === g ? entry : rootTitle?.id === g ? rootTitle : null;
  if (!known) return <div className="res-loading" role="status"><span className="res-spin" aria-hidden="true" />加载中…</div>;
  return <ResourcePage key={g} type={type} hier={{ rootId: Number(g), title: known.title, subtitle: known.subtitle || cfg.subtitle, onBack: back }} />;
}

export type { HierContext };
