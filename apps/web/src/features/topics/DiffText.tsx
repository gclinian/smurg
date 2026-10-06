// A unified diff as coloured lines (the changes of SPEC.md and PLAN.md in "Show the changes"). Reading only; the
// daemon already masked credential-like values.
import { t } from './strings.ts';

function kindOf(line: string): 'add' | 'del' | 'hunk' | 'meta' | 'context' {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

export function DiffText({ diff, label }: { diff: string; label: string }) {
  const lines = (diff.endsWith('\n') ? diff.slice(0, -1) : diff).split('\n');
  return (
    <pre className="topics-diff" role="group" aria-label={t('changes.diffLabel', { file: label })} tabIndex={0}>
      {lines.map((line, index) => (
        <span key={index} className={`topics-diff__line topics-diff__line--${kindOf(line)}`}>
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}
