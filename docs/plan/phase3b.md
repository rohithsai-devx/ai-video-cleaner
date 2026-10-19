# Phase 3b plan: the agent and the model client

Phase 3a is the code around the agent ([phase3a-architecture.md](../design/phase3a-architecture.md)). Phase 3b replaces `stub_proposal` with the LangGraph graph and replaces the two stubs (words, AI voice) with real calls. The graph rules stay the ones in [hld-lld.md](../design/hld-lld.md) ("LLD: agent graph"). This note decides the module shape and the build split. It does not start the code.

Two tracks can be built at the same time. They meet in `MediaEngines.propose`.

| Track | Builds | Runs without |
| --- | --- | --- |
| G. Graph | Nodes, checks, checkpoint, `propose` | A live model. Tests pass a scripted chat client. |
| P. Models | The chat client, then transcribe, then voice | The graph. Tests play back recorded HTTP. |

## v1 assignment

Each role names its plugin in env. The graph calls the same five methods either way. Swapping OpenAI for Anthropic, or Laya for Jev, is a new plugin behind that method plus a config value. Nodes do not change.

| Role | v1 plugin | Why |
| --- | --- | --- |
| LLM (transcript, script, editor, critique) | OpenAI `gpt-6-luna` | The lunar chat model. Text and image in, text out. [Model card](https://developers.openai.com/api/docs/models/gpt-6-luna). |
| VLM | Gemma 4 behind an OpenAI-compatible endpoint | `POST {base_url}/chat/completions`; configure `GEMMA_BASE_URL`, `GEMMA_MODEL`, and either `GEMMA_API_KEY` or the separate Modal proxy-token pair. |
| Decider | Laya on MLX, in the Mac app process | Checkpoint `aac6fef/laya-typed-decisions-mlx`. `noul` → `p_yes`. Jev is the same method once a key exists. |
| TTS | OpenAI `gpt-4o-mini-tts-2025-12-15` until an ElevenLabs key exists | That snapshot is the current speech model (`gpt-4o-mini-tts` is its alias). No word timings; duration comes from ffprobe. [Speech guide](https://developers.openai.com/api/docs/guides/text-to-speech). |
| STT | Stub words until an ElevenLabs key exists | ElevenLabs transcription replaces the stub. Not OpenAI Whisper. |

Laya loads in the Mac process that runs the agent, through `laya-mlx` 0.4.0 (`import laya_mlx as laya`, then `laya.load("aac6fef/laya-typed-decisions-mlx")`). The dependency is marked `darwin` and `arm64`, so `uv sync` on Linux CI and in the Docker worker does not install it. MLX uses the Mac GPU. The Docker worker keeps ffmpeg (`pre-cpu`, `post-io`) and never imports `laya_mlx`. The import is lazy, inside the Laya plugin. The first `load` downloads the checkpoint into the Hugging Face cache; that download is not part of install or CI. `yes_no` calls `predict` with one `noul` question. Laya does not speak chat completions. The probabilities ship over-confident; `accept_threshold` stays `0.7` and is not treated as calibrated.

## The model module

One module, `backend/app/providers/`, owns every model call. Nodes and ffmpeg never see a vendor SDK, a base URL, or a request body.

The graph's interface stays five methods. `build(settings)` picks one plugin per method:

```python
def complete(self, messages, schema) -> T: ...          # llm
def describe(self, frames, transcript, hints) -> SegContext: ...
def yes_no(self, question, ctx) -> Decision: ...
def transcribe(self, audio_uri) -> list[Word]: ...
def synthesize(self, text, voice_id, pronunciations) -> Audio: ...
```

Chat plugins share one HTTP implementation. The body is the only branch:

| Plugin | Speaks | Covers |
| --- | --- | --- |
| `openai` | `POST {base_url}/chat/completions` | OpenAI GPT. Also Gemma 4, if it is served by vLLM or any other OpenAI-compatible host. |
| `anthropic` | Anthropic Messages | Claude, when you add that key. Not built until then. |
| `laya` | `laya-mlx` inside the Mac app process | The decider. Loaded once, then `predict`. The Docker ffmpeg worker does not import it. |
| `jev` | TypeSafe HTTP | Later. Same `yes_no` method. No key, so no code yet. |

`complete` raises `ProviderError(retryable=True)` on 429, 5xx, and timeouts, and `retryable=False` when the body is not the schema. It does not retry and it does not sleep for rate limits. LangGraph `RetryPolicy` retries the node. With one worker, a semaphore inside the client honours `Limits`. The Redis token bucket in the HLD is the multi-worker version, and it stays phase 4.

Every call inserts one `provider_calls` row in its own autocommit: `stage` is the node name, `provider` is the plugin name, `model` is the model id.

The critique prompt is built in the orchestrator from `AgentState`. The client never imports the graph. `describe` downloads the JPEGs and attaches them. `yes_no` on Laya sends the summarised state as the `noul` question's state.

### Speech is a different job

Transcribe and TTS are not chat completions. They live in the same package, with their own methods, because the bytes differ:

- `transcribe(audio_uri) -> list[Word]` must return word timestamps. A server that only returns text gets an alignment step inside this method.
- `synthesize(text, voice_id, pronunciations) -> Audio` returns a clip, its duration, and word timings.

TTS v1 calls OpenAI `audio/speech` with the key already on this machine. That clip has no word timings, so duration comes from ffprobe. When an ElevenLabs key exists, `synthesize` and `transcribe` both switch to ElevenLabs: character timings grouped into words, and real words instead of the stub. The stock voice is still an open product choice; the graph does not wait on it.

Tests use a second adapter at the HTTP socket: a scripted transport that returns canned JSON. The graph tests and the client tests share that socket seam. There is no `FakeOpenAI` class for the nodes to import.

### Factory

```python
def build(settings) -> Providers: ...
```

`Providers` is the bundle the graph holds on its runtime context: the chat client plus `describe`, `yes_no`, `transcribe`, and `synthesize`. `pipeline/` and `agent/` call `build`. Nothing under `providers/` imports `agent` or `pipeline`.

## The graph

Package `backend/app/agent/`, which `check_layout.py` already requires: `agent.py`, `state.py`, `nodes/`, `tools/`, and `backend/langgraph.json`. `AgentState` stays in `contracts/pipeline.py`. Runtime context (`Providers`, `accept_threshold`, `max_attempts`, glossary) lives in `agent/state.py` and is not checkpointed.

`MediaEngines.propose` compiles nothing itself. It calls `agent.run(run, pre, providers)`, which invokes the graph with `thread_id = run_id` and `durability="sync"`. A redelivered task invokes with no new input so LangGraph resumes from the last checkpoint. The checkpointer is `PostgresSaver` in schema `lg`, on a pool built with `prepare_threshold=None`. After the graph ends, the worker maps the state to `AgentOutput` and the existing agent transaction saves proposal v1. The graph does not write `runs.status`.

`FixtureEngines` and `FAKE_WORKER` stay on the stub and claim every queue. The graph runs in `python -m app.pipeline.mac_agent` on the Mac (`agent` only). The Docker media worker claims `pre-cpu` and `post-io` only, so it never imports Laya. Speech still runs in that container, because it is an HTTP call.

### What is a node, and what is a function

The orchestrator is the only router. It returns `Command(goto=...)` and has no static edge out. Every other node has one static edge back to the orchestrator and returns a state update. A node that only forwarded to the next step would be a pass-through, so the checks are functions, not nodes.

| Piece | Kind | File | Does |
| --- | --- | --- | --- |
| `orchestrator` | Router | `nodes/orchestrator.py` | See below. |
| `run_checks` | Pure functions | `runs/checks.py` | Mechanical failures. Shared with the review API. `edl_valid` is already here. |
| `vlm_context` | Model | `nodes/vlm_context.py` | One `describe` per active segment, in parallel. |
| `transcript_context` | Model | `nodes/transcript_context.py` | One structured call over the words. |
| `script_writer` | Model | `nodes/script_writer.py` | One structured call. Writes the blocks. |
| `video_editor` | Model | `nodes/video_editor.py` | One structured call, with the `compare_frames` tool bound. Writes the EDL. |
| `compare_frames` | Tool, pure | `tools/compare_frames.py` | Returns the frame-diff scores already stored on the keyframes. |
| `advance`, `redo_or_end` | Functions | inside `orchestrator.py` | Status of the route. Not nodes. |

`RetryPolicy(max_attempts=3)` sits on the four model nodes and covers `ProviderError(retryable=True)` only. A bad script is the orchestrator's own attempt counter, which is a different knob (`max_attempts`, default 3).

### Orchestrator, in order

1. `stage == "context"`: `Command(goto=["vlm_context", "transcript_context"], update={"stage": "script"})`. Both run, then the orchestrator runs once. This is the parallel split. There is no extra fan-out node.
2. Otherwise the target is `script_writer` or `video_editor`. Call `run_checks`. Any failure goes to `redo_or_end` with those messages. No model call.
3. `yes_no` for that target. `p_yes >= accept_threshold` goes to `advance` (script → `video_editor`, edit → `END`).
4. Otherwise build the critique prompt, call `complete` on role `llm`, and `redo_or_end`.

`redo_or_end` increments `attempts[target]`. At the cap it goes to `END` with a flag. Below the cap it goes to `target` with the feedback. `accept_threshold` stays `0.7` in config and is not treated as calibrated.

### The four model nodes

`vlm_context`. Segments that are inactive get a `SegContext` written in code (`idle`, cuttable, limits taken from the segment length) and skip the model. Active segments call `describe` together, under the semaphore. The reducer `merge_by("seg_id")` replaces a segment on a redo. The node does not choose the next node.

`transcript_context`. One structured call. Writes `transcript_ctx` (steps, glossary hits, drops). Does not choose the next node.

`script_writer`. Reads `transcript_ctx`, `seg_contexts`, and `feedback["script_writer"]`. Writes `script`. Does not choose the next node.

`video_editor`. Same shape for `edit_plan`. The model may call `compare_frames`; the tool does not call a model and does not edit the plan.

### Checks to add beside `edl_valid`

Written test-first. Each returns `CheckResult` with the target from the HLD table (script checks → `script_writer`, EDL checks → `video_editor`).

| Check | Fails when |
| --- | --- |
| Length fit | Words ÷ `voice_wps` fall outside the block's `min_dur`…`max_dur` |
| Glossary kept | A glossary term from the source slice is missing in the block |
| Coverage and order | An active segment is unused, a segment is in two blocks, or blocks are out of order |
| Nothing invented | A number, URL, or quoted UI label is in neither the transcript nor `screen_text` |
| Clean only | Original-audio mode, and a word in the block is not in the source transcript |
| EDL covers script | A block's edited duration is outside its estimated speech duration ± tolerance |

`voice_wps` comes from config until `synthesize` has measured the chosen voice.

## Track G sequence

1. The new checks, with the worked cases from the HLD, next to `edl_valid`.
2. `agent/state.py` and the five node functions. Graph tests drive a scripted bundle and assert the route: fan-out, accept, a failed check goes to that check's target, a yes/no rejection returns to the step just reviewed, the cap ends with a flag and is not auto-approved, and `merge_by` replaces a segment on a second vision pass.
3. `PostgresSaver` in schema `lg`. One test kills the invoke after `script_writer` and resumes on the same `thread_id`.
4. `MediaEngines.propose` calls `agent.run` when it was given a `Providers` bundle.

## Track P sequence

1. `complete` for the `openai` wire, against recorded HTTP. Schema parse, image parts, retryable vs terminal errors, one `provider_calls` row written in its own tenant-scoped transaction. The Anthropic body is a later plugin, not this slice.
2. `build(settings)` and the vision and yes/no wrappers. The Laya plugin is a separate module the Mac process loads. Gemma's URL may be empty; a live vision call then fails as configuration.
3. `synthesize` for `gpt-4o-mini-tts-2025-12-15`. Duration comes from the audio file. Real `transcribe`, pause cuts, and the frontend voice list wait for the ElevenLabs key.

The join is one worker test: scripted HTTP, `propose` saves a proposal that `edl_valid` accepts. A live Gemma or vLLM box is a manual smoke, not a CI dependency.

## Wiring the voice through render

`RunRef` has no `voice`, and `stages._postprocess` calls `render` without it, so AI voice never leaves `media.render`'s default. When track P adds `synthesize`:

- the agent stage reads `runs.voice` into `AgentState.voice`
- `_postprocess` reads the same column and passes it to `render`
- `Engines.render` grows that keyword, and `FixtureEngines` accepts it with default `"original"`

Until step 4 of track P, AI voice keeps the silent stub clip, and the stage still has to pass `voice` for that clip to be the one that is rendered.

`video_editor` binds the `compare_frames` tool. On `gpt-6-luna`, Chat Completions accepts function calling only when `reasoning_effort` is `none`. The other three calls (transcript, script, critique) send `reasoning_effort: "low"`. A later move to the Responses API would allow reasoning and tools together.

`GEMMA_BASE_URL` may be blank until the VLM endpoint exists. Vision tests use the scripted plugin. A live run without that URL fails the VLM call with a clear config error rather than calling OpenAI for frames. OpenAI and VLM credentials are separate; `gs://` keyframes are downloaded and embedded as JPEG data URLs before the remote request.

## Left to decide, one at a time

- `GEMMA_BASE_URL`, `GEMMA_MODEL`, and optional endpoint credentials, after the server is hosted.
- The OpenAI speech voice (`coral` is the one in OpenAI's own example). The ElevenLabs voice replaces it once that key exists, and the same key turns on ElevenLabs STT.
- A calibrated `accept_threshold`, on our own review data, before anyone trusts the default `0.7`.
- `pause_ms` and frame-diff `ε`, on real recordings. Pause cuts wait for real words.

`max_attempts` stays 3.
