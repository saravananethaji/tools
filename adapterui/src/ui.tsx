import React, { useMemo } from 'react';
import { strictBase64Decode } from './parser';
import { redactSecrets } from './safety';
import type { Finding, ReviewModel, XmlNode } from './model';

const SEVERITY_ICON: Record<Finding['severity'], string> = { 'Valid': '✓', 'Invalid': '✕', 'Warning': '⚠', 'Not verified': '?' };
export function Badge({ severity }: { severity: Finding['severity'] }) { return <span className={`badge ${severity.toLowerCase().replace(' ', '-')}`}><span aria-hidden="true">{SEVERITY_ICON[severity]}</span>{severity}</span>; }
const SEVERITY_RANK: Record<Finding['severity'], number> = { 'Invalid': 0, 'Warning': 1, 'Not verified': 2, 'Valid': 3 };
export function Findings({ findings }: { findings: Finding[] }) {
  const ordered = findings.map((item, index) => ({ item, index })).sort((a, b) => SEVERITY_RANK[a.item.severity] - SEVERITY_RANK[b.item.severity] || a.index - b.index);
  const counts = useMemo(() => { const c: Record<string, number> = {}; findings.forEach((item) => { c[item.severity] = (c[item.severity] ?? 0) + 1; }); return c; }, [findings]);
  return <section className="panel"><h2>Validation findings</h2>
    {findings.length ? <>
      <p className="findings-summary">{(Object.keys(SEVERITY_RANK) as Finding['severity'][]).filter((severity) => counts[severity]).map((severity) => <span className={`summary-chip ${severity.toLowerCase().replace(' ', '-')}`} key={severity}><span aria-hidden="true">{SEVERITY_ICON[severity]}</span>{counts[severity]} {severity.toLowerCase() === 'not verified' ? 'not verified' : severity.toLowerCase()}</span>)}</p>
      {ordered.map(({ item, index }) => <article className={`finding ${item.severity.toLowerCase().replace(' ', '-')}`} key={`${item.id}-${index}`} aria-label={`${item.severity} finding`}><Badge severity={item.severity}/><div><strong>{item.message}</strong><small>{item.artifact}{item.location ? ` · ${item.location}` : ''} · {item.category}</small>{item.consequence ? <small className="finding-consequence">{item.consequence}</small> : null}{item.suggestedAction ? <small className="finding-action">Fix: {item.suggestedAction}</small> : null}</div></article>)}
    </> : <p className="muted">No static findings.</p>}
  </section>;
}
export function safeText(value: string): string { return redactSecrets(value); }
function decodedValueOf(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  if (typeof value !== 'string' || value.length < 64) return null;
  const decoded = strictBase64Decode(value, 'artifact', `$.${key}`);
  if (!decoded.text || decoded.findings.length) return null;
  return decoded.text;
}
export function NodeTree({ node }: { node: XmlNode }) { return <li><code>{node.name}</code>{Object.keys(node.attributes).length ? <span className="attributes"> {Object.entries(node.attributes).map(([key, value]) => `${key}=${safeText(value)}`).join(' ')}</span> : null}{node.text ? <span className="expression"> {safeText(node.text)}</span> : null}{node.children.length ? <ul>{node.children.map((child, index) => <NodeTree node={child} key={`${child.location}-${index}`}/>)}</ul> : null}</li>; }
export function useTableOverflow() {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = ref.current; if (!el) return;
    const update = () => el.classList.toggle('is-overflowing', el.scrollWidth > el.clientWidth);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  return ref;
}
export function OverflowTable({ children }: { children: React.ReactNode }) {
  const ref = useTableOverflow();
  return <div className="table-wrap" ref={ref}>{children}</div>;
}
