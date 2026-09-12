export const REDACTED = '[REDACTED]';
const p = (pattern: RegExp, replacement: string) => (text: string) => text.replace(pattern, replacement);
const transforms = [
  p(/(\b(?:keyPassword|password|passwd|pwd|secret|token|api[-_]?key|private[-_]?key)\s*=\s*["'])([^"']*)(["'])/gi, '$1' + REDACTED + '$3'),
  p(/(\b(?:password|passwd|pwd|secret|token|api[-_]?key|private[-_]?key)\s*>\s*)([^<]*)(\s*<)/gi, '$1' + REDACTED + '$3'),
  p(/(https?:\/\/[^\s/@:]+:)([^@\s/]+)(@)/gi, '$1' + REDACTED + '$3')
];
export function redactSecrets(text: string): string { return transforms.reduce((value, apply) => apply(value), text); }
export function containsSensitiveContent(text: string): boolean { return redactSecrets(text) !== text || /keystore|truststore/i.test(text); }
