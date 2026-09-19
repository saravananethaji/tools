import type { ReactNode } from 'react';
import './xml-viewer.css';

function redact(value: string) { return value.replace(/(\b(?:password|keyPassword|secret|token)\s*=\s*["'])[^"']*(["'])/gi, '$1[REDACTED]$2'); }
function isEntry(element: Element, entryRoute?: string) { return !!entryRoute && element.localName === 'route' && (element.getAttribute('id') === entryRoute || Array.from(element.children).some((child) => child.localName === 'from' && child.getAttribute('uri') === entryRoute)); }

function ElementNode({ element, depth, entryRoute }: { element: Element; depth: number; entryRoute?: string }) {
  const name = element.nodeName; const attributes = Array.from(element.attributes); const children = Array.from(element.childNodes).filter((node) => node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE); const entry = isEntry(element, entryRoute); const open = entry || depth < 2;
  const opening = <><span className="xml-punctuation">&lt;</span><span className="xml-tag">{name}</span>{attributes.map((attribute) => <span className="xml-attribute" key={attribute.name}> {attribute.name}<span className="xml-punctuation">=</span><span className="xml-value">&quot;{redact(attribute.value)}&quot;</span></span>)}<span className="xml-punctuation">&gt;</span></>;
  if (!children.length) return <div className="xml-line">{opening}<span className="xml-punctuation">&lt;/</span><span className="xml-tag">{name}</span><span className="xml-punctuation">&gt;</span></div>;
  return <details className={`xml-element ${entry ? 'xml-entry-route' : ''}`} open={open}><summary>{opening}{entry ? <span className="xml-entry-label">Runtime entry point</span> : null}</summary><div className="xml-children">{children.map((child, index): ReactNode => {
    if (child.nodeType === Node.ELEMENT_NODE) return <ElementNode element={child as Element} depth={depth + 1} entryRoute={entryRoute} key={index}/>;
    if (child.nodeType === Node.COMMENT_NODE) return <div className="xml-comment" key={index}>&lt;!--{child.textContent}--&gt;</div>;
    const text = child.textContent?.trim(); return text ? <div className="xml-text" key={index}>{redact(text)}</div> : null;
  })}</div><div className="xml-line"><span className="xml-punctuation">&lt;/</span><span className="xml-tag">{name}</span><span className="xml-punctuation">&gt;</span></div></details>;
}

export function XmlViewer({ document, entryRoute }: { document: Document; entryRoute?: string }) { return <div className="xml-viewer" aria-label="Collapsible decoded Camel XML"><div className="xml-declaration">&lt;?xml version=&quot;1.0&quot;?&gt;</div><ElementNode element={document.documentElement} depth={0} entryRoute={entryRoute}/></div>; }
