import type { components } from "@/api/generated/schema";
import { formatClock } from "@/lib/clock";
import { Button } from "@/ui/button";

type Change = components["schemas"]["Change"];
type Entry = components["schemas"]["EDLEntry"];

export type DoneByAiPanelProps = {
  changes: Change[];
  entries: Entry[];
  editable: boolean;
  onUndo: (change: Change) => void;
  onRedo: (change: Change) => void;
};

function changeLabel(change: Change): string {
  if (change.kind === "pause") return "Pause removed";
  if (change.kind === "filler") return "Filler word removed";
  if (change.kind === "retake") return "Retake removed";
  if (change.kind === "speed") return `Sped up ${change.speed ?? 1}×`;
  if (change.kind === "hold") return `Held last frame ${change.hold_s ?? 0} s`;
  return "Cut";
}

function spanLabel(span: number[]): string {
  const start = span[0] ?? 0;
  const end = span[1] ?? start;
  const from = formatClock(start);
  return start === end ? from : `${from} to ${formatClock(end)}`;
}

export function DoneByAiPanel({ changes, entries, editable, onUndo, onRedo }: DoneByAiPanelProps) {
  if (changes.length === 0) {
    return <p className="m-0 text-sm text-muted">Nothing has been changed yet.</p>;
  }

  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {changes.map((change) => {
        const entry = entries.find((candidate) => candidate.seg_id === change.change_id);
        const undone = entry ? entry.action === "keep" : change.undone;
        return (
          <li key={change.change_id}>
            <article className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <h3 className="m-0 text-sm font-medium">{changeLabel(change)}</h3>
                <span className="font-mono text-xs tabular-nums text-muted">
                  {spanLabel(change.span)}
                </span>
                {editable ? (
                  <Button
                    variant="secondary"
                    className="ml-auto"
                    onClick={() => (undone ? onRedo(change) : onUndo(change))}
                  >
                    {undone ? "Redo" : "Undo"}
                  </Button>
                ) : null}
              </div>
              <p className="m-0 text-sm leading-normal text-muted">{change.reason}</p>
            </article>
          </li>
        );
      })}
    </ul>
  );
}
