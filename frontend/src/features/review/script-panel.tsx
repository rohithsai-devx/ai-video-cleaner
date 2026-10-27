import type { components } from "@/api/generated/schema";
import { cx } from "@/ui/cx";

type ScriptBlock = components["schemas"]["ScriptBlock"];

export type ScriptPanelProps = {
  blocks: ScriptBlock[];
  draftTexts: Record<string, string>;
  flaggedIds: Set<string>;
  editable: boolean;
  onTextChange: (blockId: string, text: string) => void;
};

export function ScriptPanel({
  blocks,
  draftTexts,
  flaggedIds,
  editable,
  onTextChange,
}: ScriptPanelProps) {
  return (
    <section aria-labelledby="script-panel-heading" className="flex flex-col gap-3">
      <h2 id="script-panel-heading" className="m-0 text-lg">
        Script
      </h2>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {blocks.map((block, index) => {
          const text = draftTexts[block.block_id] ?? block.text;
          const flagged = flaggedIds.has(block.block_id);
          return (
            <li
              key={block.block_id}
              className={cx(
                "flex flex-col gap-2 rounded-xl border bg-surface p-4",
                flagged ? "border-warning/40 bg-warning-soft" : "border-line",
              )}
            >
              <label
                htmlFor={`block-${block.block_id}`}
                className="flex justify-between gap-3 text-xs text-muted"
              >
                <span className="flex items-center gap-2">
                  Script block {index + 1}
                  {flagged ? <FlaggedTag /> : null}
                </span>
                <span>
                  {block.est_dur.toFixed(1)} s, target {block.target_min} to {block.target_max} s
                </span>
              </label>
              <textarea
                id={`block-${block.block_id}`}
                value={text}
                rows={3}
                readOnly={!editable}
                onChange={(event) => onTextChange(block.block_id, event.target.value)}
                className="w-full resize-y rounded-lg border border-line-strong bg-surface p-3 text-sm"
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function FlaggedTag() {
  return (
    <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
      Flagged
    </span>
  );
}
