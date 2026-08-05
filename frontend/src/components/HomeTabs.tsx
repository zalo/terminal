// Home view switcher: classic session list ⇄ canvas. The choice is
// remembered per device (localStorage) by App.tsx.

interface HomeTabsProps {
  current: 'list' | 'canvas';
  onSwitch: (view: 'list' | 'canvas') => void;
  glass?: boolean;
}

export default function HomeTabs({ current, onSwitch, glass }: HomeTabsProps) {
  const base = 'px-3.5 py-1.5 rounded-full text-xs font-medium transition-colors';
  return (
    <div
      className={`flex gap-0.5 p-1 rounded-full ${glass ? 'glass' : ''}`}
      style={glass ? undefined : { background: '#252540', border: '1px solid #2d2d4a' }}
      role="tablist"
      aria-label="Home view"
    >
      {(['list', 'canvas'] as const).map((v) => (
        <button
          key={v}
          role="tab"
          aria-selected={current === v}
          onClick={() => onSwitch(v)}
          className={base}
          style={current === v
            ? { background: glass ? 'var(--cv-accent)' : '#4fd1c5', color: glass ? 'var(--cv-bg)' : '#1a1a2e' }
            : { color: glass ? 'var(--cv-ink-dim)' : '#94a3b8' }}
        >
          {v === 'list' ? 'Sessions' : 'Canvas'}
        </button>
      ))}
    </div>
  );
}
