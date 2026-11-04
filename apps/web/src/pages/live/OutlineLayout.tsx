import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { defaultNames, type Stage } from './scriptOutline';

export function OutlineLayout({ stages, children }: { stages: Stage[]; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [current, pick] = useState(0);
  useEffect(() => {
    const track = () => {
      const nodes = root.current?.querySelectorAll<HTMLElement>('[data-stage]');
      if (!nodes?.length) return;
      const top = Math.max(100, Math.min(innerHeight / 3, 240));
      const first = Array.from(nodes).find((n) => n.getBoundingClientRect().bottom >= top);
      pick(Number((first ?? nodes[nodes.length - 1]).dataset.stage));
    };
    window.addEventListener('scroll', track, true);
    return () => window.removeEventListener('scroll', track, true);
  }, []);
  return (
    <div className="sc-outline-layout" ref={root}>
      <nav aria-label="话术环节目录">
        <strong>环节目录</strong>
        {stages.map((s, i) => (
          <button
            key={i}
            type="button"
            aria-current={i === current ? 'location' : undefined}
            onClick={() => {
              const el = root.current?.querySelector<HTMLElement>('[data-stage="' + i + '"]');
              el?.scrollIntoView({ block: 'center' });
              el?.querySelector('textarea')?.focus({ preventScroll: true });
              pick(i);
            }}
          >
            <small>{String(i + 1).padStart(2, '0')}</small>
            {s.name || '未命名环节'}
          </button>
        ))}
      </nav>
      <div
        className="sc-outline-content"
        onMouseOver={(e) => {
          const el = (e.target as Element).closest<HTMLElement>('[data-stage]');
          if (el) pick(Number(el.dataset.stage));
        }}
        onFocus={(e) => {
          const el = e.target.closest<HTMLElement>('[data-stage]');
          if (el) pick(Number(el.dataset.stage));
        }}
      >
        {children}
      </div>
    </div>
  );
}

type Template = { id: number; name: string; stages: string[] };
export function OutlineTemplates({ stages, apply }: { stages: Stage[]; apply: (names: string[]) => void }) {
  const [templates, setTemplates] = useState<Template[]>([]),
    [id, setId] = useState(0),
    [name, setName] = useState(''),
    [msg, setMsg] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api<Template[]>('/live/scripts/templates')
      .then((rows) => {
        if (live) setTemplates(rows);
      })
      .catch((e) => {
        if (live) setMsg(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  const preset = templates.find((t) => t.name === '默认目录') ?? {
    id: 0,
    name: '默认目录',
    stages: defaultNames,
  };
  const list = [preset, ...templates.filter((t) => t.name !== '默认目录')];
  const selected = list.find((t) => t.id === id) ?? preset;
  async function save(overwrite = false) {
    if (
      overwrite &&
      !window.confirm('更新「' + selected.name + '」供本公司所有产品使用？已保存的话术保持原目录。')
    )
      return;
    setBusy(true);
    try {
      const update = overwrite && selected.id > 0;
      const r = await api<Template>('/live/scripts/templates' + (update ? '/' + selected.id : ''), {
        method: update ? 'PUT' : 'POST',
        body: {
          name: overwrite ? selected.name : name.trim(),
          stages: stages.map((s) => s.name.trim()),
          ...(update ? { previous: selected.stages } : {}),
        },
      });
      setTemplates((old) => [...old.filter((t) => t.id !== r.id), r]);
      setId(r.id);
      setName('');
      setMsg('模板已保存，可在其他产品中载入');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="sc-library">
      <summary>目录模板</summary>
      <div className="sc-bar">
        <label>
          选择模板
          <select value={selected.id} onChange={(e) => setId(Number(e.target.value))}>
            {list.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            apply(selected.stages);
          }}
        >
          载入目录
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || stages.some((s) => !s.name.trim())}
          onClick={() => void save(true)}
        >
          更新所选模板
        </button>
        <label>
          另存当前目录
          <input
            value={name}
            maxLength={100}
            placeholder="模板名称"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !name.trim() || stages.some((s) => !s.name.trim())}
          onClick={() => void save()}
        >
          保存为模板
        </button>
      </div>
      {msg && <p role="status">{msg}</p>}
    </details>
  );
}
