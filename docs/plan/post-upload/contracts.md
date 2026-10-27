# Shared contracts

Every new or changed API shape in this rework, in one place. Backend lanes implement these exactly; frontend lanes build against them (generated types once the backend merges, `page.route` fixtures before). A lane that finds a contract does not fit stops and reports; it does not change this file on its own.

Pydantic is the source; `backend/openapi.json` and `frontend/src/api/generated/schema.d.ts` are regenerated from it. Times are seconds on the **source** recording's timeline unless named otherwise. `Span = tuple[float, float]`.

## C1. Run creation (BE-B)

```python
# contracts/pipeline.py
class FixOptions(BaseModel):
    pauses: bool = True       # "Remove long pauses"
    filler: bool = True       # "Remove filler words"
    retakes: bool = True      # "Remove retakes"
    slow_parts: bool = True   # "Speed up slow parts"

# runs/schemas.py
class RunCreate(BaseModel):          # POST /videos/{video_id}/runs, existing route
    mode: RunMode                    # "review" = "Show me before it renders" on; "auto" = off
    voice: VoiceMode                 # "original" | "ai"
    voice_id: str | None             # required iff voice == "ai" (existing validator)
    fix_options: FixOptions = FixOptions()
```

Stored in `runs.fix_options jsonb not null default '{}'` (migration 10). `{}` reads as all true. `Run` (`GET /runs/{id}`) gains `fix_options: FixOptions`.

## C2. Voices (BE-B)

```python
class VoiceOption(BaseModel):
    id: str            # provider voice id, e.g. "coral"; never shown in the UI
    label: str         # display name, e.g. "Coral"
    hint: str          # one line, e.g. "Warm, calm"
    sample_path: str   # "/voice-samples/coral.mp3", a static file in frontend/public

class VoiceList(BaseModel):
    default_voice_id: str          # settings.openai_speech_voice
    voices: list[VoiceOption]
```

`GET /voices` -> `VoiceList`. Static config in `shared/config.py`. Auth required, no tenant data.

## C3. Run history (BE-B)

```python
class RunListItem(BaseModel):
    run_id: str
    status: RunStatus
    created_at: datetime
    voice: VoiceMode
    voice_id: str | None
    needs_you: int        # added by BE-E with spots: open spots on the latest proposal, 0 when none
```

`GET /videos/{video_id}/runs` -> `list[RunListItem]`, newest first, at most 20. 404 when the video is not visible.

## C4. Estimate (BE-B)

`Video` gains `estimated_run_seconds: int | None`. Null until the workspace has a finished (`done`) run. Value: `duration_s` times the median of `(finished_at - started_at) / videos.duration_s` over the workspace's last 20 done runs, rounded up to whole seconds.

## C5. Shares and original playback (BE-C)

```python
# contracts/enums.py
ShareKind = Literal["cleaned", "raw"]

# shares/schemas.py
class ShareCreate(BaseModel):
    kind: ShareKind = "cleaned"
    visibility: ShareVisibility = "link"
    expires_at: datetime | None = None

class ShareLink(BaseModel):
    slug: str
    url: str              # {FRONTEND_BASE_URL}/s/{slug}
    kind: ShareKind
    created_at: datetime

class SharePublic(BaseModel):       # GET /s/{slug}, shape unchanged; playback_url follows the kind
    title: str
    playback_url: str
    poster_url: str | None = None
```

- `POST /videos/{id}/shares` with `kind="raw"`: allowed when `raw_uri` is set (any status from `uploaded`); 409 `raw_not_available` otherwise. `kind="cleaned"` keeps today's rules. Idempotent per kind: when a link-visibility share of that kind exists, return it (201 the first time, 200 after).
- `ShareCreated` gains `kind: ShareKind`.
- `GET /videos/{id}/shares` -> `list[ShareLink]` (new).
- `Video` gains `original_url: str | None` (signed playback of `raw_uri`, whenever `raw_uri` is set) and `download_url: str | None` (signed with `Content-Disposition: attachment` for the output MP4, `ready` only), `original_download_url: str | None` (same, for `raw_uri`).

## C6. Retry and failure (BE-D)

`POST /runs/{run_id}/retry` -> 202 `RunSummary`. 404 when not visible; 409 `run_not_failed` when status is not `failed`; 409 `run_not_current` when the video's `current_run_id` is another run; 409 `not_retryable` when `error.retryable` is false.

`RunFailedEvent` shape is unchanged, but its values change:

| Field | Before | After |
|---|---|---|
| `stage` | queue name (`pre-cpu`, `agent`, `post-io`) | user step number as a string: `"1"`, `"3"` or `"4"` |
| `message` | exception text | plain sentence from a fixed table in `pipeline/stages.py` (BE-D doc); exception text goes to logs only |
| `retryable` | always `true` | the exception's own `retryable`, default `true` for unknown errors |

## C7. Editor data (BE-E)

`ProposalView` (`GET` and `PUT /runs/{id}/proposal`) gains five read-only fields. They are computed from the stored proposal on every read, so a saved edit returns fresh values.

```python
ChangeKind = Literal["pause", "filler", "retake", "cut", "speed", "hold"]

class Change(BaseModel):           # one row in "Done by AI"
    change_id: str                 # = the EDL entry's seg_id; stable across versions
    kind: ChangeKind
    span: Span                     # the EDL entry's src
    speed: float | None = None     # kind == "speed"
    hold_s: float | None = None    # kind == "hold"
    reason: str                    # one plain line, no ids (D3)
    undone: bool                   # true when the user set this entry back to keep

class FixPatch(BaseModel):         # exactly one of the two is set
    entry: EDLEntryPatch | None = None    # {seg_id, action, speed, freeze_s}
    block: BlockPatch | None = None       # {block_id, text}

class Fix(BaseModel):
    fix_id: str
    label: str                     # button text, e.g. "Hold the last frame 4 s"
    patch: FixPatch

class Spot(BaseModel):             # one "Needs you" card
    spot_id: str
    span: Span
    question: str                  # plain words, says what is wrong (principle 2)
    fixes: list[Fix]               # ordered; fixes[0] is the default
    chosen_fix_id: str | None      # set once picked; null = open
    chosen_by: Literal["user", "default"] | None   # "default" = applied on approve (D9)

class Chapter(BaseModel):
    title: str                     # 1 to 4 words, e.g. "Billing page"
    start: float
    end: float

class ScriptLine(BaseModel):       # AI-voice mode only; empty list in original mode
    block_id: str
    text: str
    start: float                   # placement on the source timeline
    end: float
    overflow_s: float              # > 0 draws the red "+N s" tail

class ProposalView(BaseModel):
    proposal: Proposal
    keyframes: list[KeyframeThumb] = []
    changes: list[Change] = []
    spots: list[Spot] = []
    chapters: list[Chapter] = []
    script_lines: list[ScriptLine] = []
    waveform_url: str | None = None   # signed URL of peaks JSON: {"rate": 50, "peaks": [0..1 floats]}
```

Stored-model additions behind these fields: `Step.title: str = ""`, `Proposal.spots: list[Spot] = []` (column `proposals.spots`, migration 09), `PreprocessResult.peaks_uri: str | None = None`.

Choosing a fix: the frontend applies `patch` to its draft, then calls the existing `PUT /runs/{id}/proposal` with `ProposalUpdate` plus a new optional field:

```python
class ProposalUpdate(BaseModel):
    base_version: int
    script: Script
    edit_plan: EditPlan
    seg_contexts: list[SegContext]
    chosen_fixes: dict[str, str] = {}   # spot_id -> fix_id, written as review_edits rows (kind fix_chosen)
```

On approve, any spot without a choice takes `fixes[0]` (D9), applied by the backend before rendering.

## C8. Progress events (BE-E)

New SSE event `run.progress` on `GET /runs/{id}/events`, sent while `agent_running`:

```python
class RunProgressEvent(BaseModel):
    pauses: int | None = None       # idle cuts in the current edit plan
    filler: int | None = None       # filler drops
    retakes: int | None = None      # false_start + retake drops
    slow_parts: int | None = None   # speed entries
    chapters: list[Chapter] = []
```

Null means "not known yet". Each event carries the latest totals, not deltas. Not stored: after a reload the panel shows nothing until the next event, and once the proposal is ready, the counts come from `ProposalView.changes`.

## C9. Frontend seams (FE lanes)

```ts
// features/videos/video-screen.tsx, owned by FE-1; FE-4 renders into it
export type ShareSlot = (v: {
  videoId: string;
  status: components["schemas"]["VideoStatus"];
  title: string;
  playbackUrl?: string | null;
  originalUrl?: string | null;
}) => ReactNode;
// VideoScreen props gain: renderShare?: ShareSlot (placed in the left column, under the player)

// ui/media-player.tsx, owned by FE-3; FE-4 uses it
type PlayerSegment = { start: number; end: number; kind: "removed" | "speed" | "hold"; speed?: number; label: string };
type PlayerProps = {
  src: string;
  duration: number;              // seconds of the file being played
  mode: "cleaned-preview" | "file";   // cleaned-preview skips removed segments of the source file
  segments?: PlayerSegment[];
  chapters?: { title: string; start: number }[];
  badge?: string;
  onTime?: (t: number) => void;  // source-time clock
  seekTo?: number;               // controlled seek
};

// lib/cut-map.ts, owned by FE-3
export function toOutputTime(t: number, segs: PlayerSegment[]): number;
export function toSourceTime(t: number, segs: PlayerSegment[]): number;
export function outputLength(duration: number, segs: PlayerSegment[]): number;
export function segmentsFromChanges(changes: components["schemas"]["Change"][]): PlayerSegment[]; // skips undone
```
