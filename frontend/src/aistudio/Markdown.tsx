/** Minimal Markdown for chat answers, rendered as React elements (never as raw HTML). */
import type { ReactNode } from "react";

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const id = `${key}-${index++}`;
    if (token.startsWith("`")) out.push(<code key={id} className="rounded bg-[var(--app-control-bg)] px-1 py-0.5 font-mono text-[0.9em]">{token.slice(1, -1)}</code>);
    else if (token.startsWith("**")) out.push(<strong key={id}>{token.slice(2, -2)}</strong>);
    else out.push(<em key={id}>{token.slice(1, -1)}</em>);
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());

export default function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${i}`;
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={key} className="overflow-auto rounded-lg bg-[var(--app-control-bg)] p-2 font-mono text-xs">{body.join("\n")}</pre>);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const size = heading[1].length <= 2 ? "text-base" : "text-sm";
      blocks.push(<div key={key} className={`${size} mt-1 font-semibold`}>{inline(heading[2], key)}</div>);
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      blocks.push(<div key={key} className="overflow-auto rounded-lg border border-[var(--app-border)]"><table className="min-w-full text-xs">
        <thead className="bg-[var(--app-control-bg)]"><tr>{head.map((cell, n) => <th key={n} className="px-2 py-1.5 text-left font-semibold">{inline(cell, `${key}h${n}`)}</th>)}</tr></thead>
        <tbody>{rows.map((row, r) => <tr key={r} className="border-t border-[var(--app-border)]">{row.map((cell, n) => <td key={n} className="px-2 py-1.5">{inline(cell, `${key}r${r}c${n}`)}</td>)}</tr>)}</tbody>
      </table></div>);
      continue;
    }
    const bullet = /^\s*([-*•]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && bullet.test(lines[i])) {
        const nested = /^\s{2,}/.test(lines[i]);
        items.push(<li key={i} className={nested ? "ml-4" : ""}>{inline(lines[i].replace(bullet, ""), `${key}i${i}`)}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={key} className="list-decimal space-y-0.5 pl-5">{items}</ol> : <ul key={key} className="list-disc space-y-0.5 pl-5">{items}</ul>);
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith("```") && !/^#{1,4}\s/.test(lines[i]) && !bullet.test(lines[i]) && !lines[i].trim().startsWith("|")) paragraph.push(lines[i++]);
    blocks.push(<p key={key}>{paragraph.flatMap((part, n) => (n ? [<br key={`br${n}`} />, ...inline(part, `${key}p${n}`)] : inline(part, `${key}p${n}`)))}</p>);
  }
  return <div className="space-y-2 text-sm leading-relaxed">{blocks}</div>;
}
