# Voice dictation for PiNet — research + plan

Goal: Wispr-Flow-class dictation *inside the composer*. Not just ASR — a fast
correctness/edit pass that fixes mechanics without inventing content, at a latency
that never breaks the user's flow.

Status: proposal. Nothing implemented yet. P0 is a measurement spike that can
change the provider choices below.

---

## 1. The target experience

Hold the mic (or a key), speak, release → polished text appears in the composer:
punctuated, filler removed, obvious ASR errors fixed, **your words preserved**.
No "Here's a cleaned up version:" framing, no added sentences, no rewritten
numbers or identifiers.

Two stages, exactly like the state of the art:

1. **ASR** — audio → raw transcript.
2. **Cleanup** — raw transcript → final text, with correctness edits.

---

## 2. What the research says

### 2.1 The latency target is published, and it is aggressive

Wispr Flow's co-founder/CTO, in [Technical challenges behind
Flow](https://wisprflow.ai/post/technical-challenges):

> Our users expect full transcription and LLM formatting/interpretation of their
> speech within **700ms** of when they stop speaking. Any slower, and users get
> impatient. […] We need to optimize model inference so we can run E2E **ASR
> inference in <200ms, E2E LLM inference in <200ms, and have a maximum networking
> budget of 200ms**.

And on how they measure it:

> We measure latency on a p90 or p99 basis for each user; **we don't care at all
> about p50**. We're optimizing the p99 experience for the p99 user.

Their [Baseten case study](https://www.baseten.co/resources/customers/wispr-flow/)
adds the pipeline shape: **<700ms end-to-end at P99**, **100+ tokens in <250ms**,
and a **fine-tuned Llama doing "real-time transcript cleanup"** — i.e. the edit
pass is a small, specialised, low-latency LLM step, not a big general model.

Also worth stealing: they explicitly optimise ASR for *context* (speaker, topic,
history), and they treat user corrections as training signal.

**Takeaway:** budget ~700ms p99 for the whole thing, split roughly
ASR 200 / cleanup 200 / network 200.

### 2.2 The failure mode that matters most: cleanup hallucination

[Resonant's write-up](https://www.onresonant.com/blog/hallucination-detection)
is the clearest statement of the problem, and it is exactly the risk of the
feature being asked for:

> Cloud text cleanup routes your raw transcript through an LLM […]. This works
> well 95% of the time. The other 5%, the LLM does one of these: **rewrites your
> meaning** (changes specific numbers, names, or technical terms to more
> "natural" alternatives) · **adds content** · **drops content** · **prefixes with
> meta-commentary**.

Their mitigation is the design I'd copy wholesale — **three automated checks on
every cleanup response, and on rejection, fall back to the raw transcript**:

| Guard | What it catches |
|---|---|
| **Bad-prefix detection** | "Here's…", "Sure…", "I've cleaned…", "The corrected version…" |
| **Coverage check** | % of the original words present in the output; too low ⇒ the model dropped content ⇒ reject |
| **Content-novelty ratio** | how much new content appeared that wasn't in the transcript; too high ⇒ the model invented content ⇒ reject |

Plus prompt-level hard constraints: *do not add information; preserve all
numbers, names and technical terms exactly; return only the cleaned text; if the
input has no meaningful content, return it unchanged.*

**Takeaway:** the edit pass is not "call an LLM and hope". It is prompt +
deterministic guards + a cheap fallback, and the guards are pure functions we can
unit-test with adversarial inputs.

### 2.3 ASR options (and a deprecation that matters)

| Option | Latency / throughput | Cost | Notes |
|---|---|---|---|
| **Groq `whisper-large-v3-turbo`** | positioned for "real-time processing" | **$0.04 / audio-hour** | OpenAI-compatible `/v1/audio/transcriptions`; a 10s utterance ≈ $0.00001 |
| **OpenAI `gpt-4o-mini-transcribe` / `gpt-4o-transcribe`** | fast; streaming variants exist | higher than whisper | `whisper-1` is on the deprecation path (legacy audio families) |
| **Fireworks audio** | "1 hour of audio in 4 seconds" at launch (2024) | was cheap | **Deprecated 2026-06-10.** Their own changelog entry is titled *"Audio inference and image generation deprecation"* and reads, in full: *"Audio inference and image generation are deprecated."* Verified against the live API with this account's key: `GET /v1/models` → 200, 27 models, **none audio**; `POST /v1/audio/transcriptions` → **401** for every whisper id (`whisper-large-v3`, `whisper-v3`, and the turbo variants). Fireworks' *LLMs* remain first-class for the cleanup pass. |
| **Local — NVIDIA Parakeet (FastConformer transducer, MLX)** | *streaming*: "a streaming machine that keeps up with the microphone" | free | best structural fit for local live dictation; Apple Silicon |
| **Local — Whisper large-v3 (whisper.cpp / MLX)** | windowed/autoregressive (not streaming by nature) | free | accurate, mature; needs a few hundred MB |
| **Browser Web Speech API** | ~instant (OS-level) | free | Chrome routes audio to Google; Safari support is partial; Firefox ✗ |

Whisper supports **`initial_prompt` biasing** to improve proper nouns and jargon —
[OpenAI's prompting guide](https://developers.openai.com/cookbook/examples/whisper_prompting_guide):
*"Pass names in the prompt to prevent misspellings."* Directly useful for
`PiNet`, `TypeScript`, `tmux`, `pi`, session ids, and the user's own identifiers.

**Takeaway:** don't build on Fireworks' transcription endpoint (dead), keep the
transcriber pluggable, and bias the ASR with domain vocabulary.

### 2.4 Our own measured constraints (not estimates)

Measured against the live system rather than assumed:

- **Relay RTT (controller ↔ host, via the coordinator): VM 5ms, MacBook Air 37ms,
  MacBook Pro 88ms** (median of 5 command/ack round trips). So the audio upload
  and the text return together cost roughly **40–180ms** — inside Wispr's 200ms
  network budget. The topology is *not* the problem I initially assumed.
- The coordinator is a **whitelist relay**: a new frame type needs one `case`, and
  it forwards `data` verbatim, never inspecting it. Audio therefore stays opaque
  to the coordinator, by construction.
- `src/crypto/e2e.mjs` already has raw-byte `seal`/`open` next to `sealJson`, so
  audio chunks need no JSON/base64-of-JSON layer.
- **The VM has no `ffmpeg`, `whisper`, or `sox`** — only `python3`. Local ASR
  means an install, and the Macs (not the VM) are the sensible local hosts.
- The host's pi auth already holds **`deepseek` + `fireworks`** keys, and the
  model list includes genuinely fast models: `deepseek-flash`,
  `fireworks/…/nemotron-lightning-3p5-30b-a3b` (3B active), `glm-5p3-flash`.
  → **the cleanup pass needs no new credential.** Cloud ASR would.
- **The coordinator's WebSocket sets no `maxPayload`, and there is no per-type
  byte cap.** We should add both — this is a pre-existing gap that a voice path
  would otherwise widen.

---

## 3. Proposed architecture

### 3.1 Transport: reuse the E2E attachment, add two opaque frame types

- `session.audio` — browser → host, sealed PCM chunks (never plaintext to the coordinator).
- `session.voice` — host → browser: `partial` (tier-1), `final` (polished), `error`.

Coordinator change is two whitelist entries plus **per-type byte caps** we should
add anyway. No new socket, no new port, no new authentication path — it rides the
existing pinned, E2E attachment.

Chunking: AudioWorklet → 16kHz mono PCM16 → 250ms chunks (8KB) → `seal` (~8KB) →
~11KB on the wire. Well below any sane cap, and streamed while the user speaks.

### 3.2 Pipeline

```
mic → AudioWorklet (16k mono) → Silero VAD → segment (pause or key release)
      → streamed chunked upload (sealed) → host
      → Transcriber (pluggable) → raw transcript
      → cleanup LLM + guards → final text
      → session.voice → composer replaces the provisional span (one-tap undo)
```

### 3.3 Two-tier perceived latency

- **Tier 1 — instant, best-effort.** Browser Web Speech API streams live partials
  into the composer as you speak (zero network). Optional; absent and silent where
  unsupported.
- **Tier 2 — authoritative.** The host's ASR + cleanup *replaces exactly that
  span* when it lands, with a one-tap **undo** back to the raw transcript.

Insert at the caret, never clobbering the existing draft. Track the dictated span
as one undoable unit. If the user edits inside that span while cleanup is in
flight, **do not clobber their edit** — apply a word-level diff only to the
untouched ranges.

### 3.4 Pluggable transcriber

```js
// { id, transcribe(chunks, { hotwords, signal }) -> { text, words?, ms } }
```
Implementations: `openai-compatible` (Groq/OpenAI), `local` (whisper.cpp or
parakeet-mlx via a spawned binary), `browser` (tier-1 preview only).
Default: `local` if the binary exists, else `openai-compatible` if a key is
configured, else tier-1-only. The choice is a setting, and the UI states plainly
whether audio stays on your machines.

### 3.5 The cleanup pass (the actual ask)

- Model: fastest available, reasoning off, temperature 0, `max_tokens ≈ 1.35 ×
  input length`, **streamed** so tokens land as they generate.
- Prompt: the four hard constraints from §2.2 + user style/context.
- **Guards, evaluated before any text is applied** (pure functions, unit-tested):
  - `hasMetaPrefix(text)` → reject
  - `coverage(raw, clean) ≥ τ_c` else reject
  - `novelty(raw, clean) ≤ τ_n` else reject
  - length-ratio sanity; empty/tiny input → return raw unchanged
  - Starting thresholds: **τ_c ≈ 0.7, τ_n ≈ 0.15** — *to be tuned from the P0
    measurements, not trusted as-is.*
- On rejection: apply **deterministic light formatting** to the raw transcript
  (sentence casing, spacing) instead. Never show nothing; never show a rewrite.
- Apply as a **diff patch**, not a wholesale replace (no flicker, no lost edits).
- Later: mine `(raw → user-corrected)` pairs locally into hotwords — Wispr's
  "learning from corrections", and the cheapest quality win available.

---

## 4. Latency budget (now measured, not estimated)

P0 spike done against Groq (key provided) on this host:

| Stage | Budget | **Measured** | Basis |
|---|---|---|---|
| capture + VAD + endpointing | ~0 | ~0 | on-device, overlaps speech |
| audio → host | 45ms | **45ms** | one-way, from the 88ms RTT measurement |
| ASR | <200ms | **188ms** for 15s audio (`whisper-large-v3-turbo`, RTF ~80×); 226ms for large-v3 | Groq, median of 3 |
| cleanup LLM | <200ms | **96ms TTFT / 198ms total** (`qwen/qwen3.8-27b`) | Groq, median of 4 |
| result → browser | 45ms | **45ms** | measured |
| **total after release** | **<700ms p99** | **~380–470ms** | |

So the 700ms p99 target is reachable with real headroom, using **one provider for
both stages**:

- **ASR:** Groq `whisper-large-v3-turbo` — $0.04/audio-hour, ~80× realtime, accepts
  a hotword `prompt` (188ms → 202ms, i.e. biasing is nearly free).
- **Cleanup:** Groq `qwen/qwen3.8-27b` — the fastest model measured that also
  passed every guard (see §9.4).

### 4.1 Model measurements for the cleanup pass

Median of 4 streamed runs, temperature 0, cleaning a 45-word dictation; guards =
preserved `100` / `429` / `pinet` and returned no meta-commentary:

| Model | TTFT | Total | Guards | Notes |
|---|---|---|---|---|
| **groq `allam-2-7b`** | 73ms | **110ms** | ✗ loses "PiNet" | fastest, **unusable** — exactly what the term guard is for |
| **groq `qwen/qwen3.8-27b`** | 96ms | **198ms** | ✓ | **the choice** |
| groq `gpt-oss-20b` (`reasoning_effort: low`) | 357ms | 406ms | ✓ | 645ms TTFT at default effort — reasoning must be off |
| groq `gpt-oss-120b` (`low`) | 454ms | 547ms | ✓ | |
| deepseek `deepseek-chat` | 459ms | 614ms | ✓ | |
| fireworks `glm-5p3-fast` | 1166ms | 1267ms | ✓ | emitted 996 chars of reasoning first |

Groq's LPU is **5–10× faster** than the same class of model on Fireworks or
DeepSeek for this workload. (Four Fireworks ids returned no parseable streaming
content in this harness — an unresolved provider-shape issue on my side, not a
claim that they're broken; the ones that did parse were ≥1.2s.)

### 4.2 ASR hallucination is real, and it is not hypothetical

Feeding Whisper a synthetic 15s tone (i.e. **no speech at all**) produced:

- `whisper-large-v3` → **"Thanks for watching!"**
- `whisper-large-v3-turbo` → **" ."**

This is the classic Whisper no-speech hallucination, reproduced on our own
endpoint. The pipeline must therefore treat a raw transcript as **untrusted
input**, never as ground truth — which is the whole argument for §2.2's guards
and for a no-speech / empty-transcript check *before* the LLM ever sees it.

---

## 5. Prior art: how open-source projects actually do LLM text correction

Surveyed the dictation apps and libraries that implement a correction layer.
The consistent finding is that mature projects **layer** the cleanup rather than
throwing everything at an LLM:

| Layer | What it is | Where it's done |
|---|---|---|
| **1. ASR-level** | filler removal, spoken punctuation, hotword biasing | provider features: Deepgram removes disfluencies by default; Voxtype's `spoken_punctuation`; Whisper's `initial_prompt` |
| **2. Deterministic text-level** | regex/`sed` filler deletion, trailing punctuation, word replacement | Voxtype `filler_words` array + `sed`; whisper-writer's `remove_trailing_period` / `add_trailing_space` |
| **3. LLM-level** | prompted rewrite for judgement calls | Handy, VoiceInk, Whispering, amical, Voxtype's `post_process` hook |

### 5.1 Per-project notes

- **Voxtype** (Rust) — most instructive. Ships a built-in `filler_words` list
  (`uh, um, er, ah, eh, hmm, hm, mm, mhm`) applied *before* anything else, plus an
  `[output.post_process]` hook that pipes text to an arbitrary shell command
  (Ollama, LM Studio, `sed`, a Python script). Two things it states plainly:
  *"Adds **2–5 seconds** latency depending on model size"* and *"For most users,
  Whisper large-v3-turbo with Voxtype's built-in `spoken_punctuation` is
  sufficient."* It also warns that *"LLMs interpret text literally"* — a
  hallucination caveat in the user docs.
- **whisper-writer** (Python) — the most-used OSS push-to-talk app. Its
  post-processing is **entirely deterministic** (trailing period, trailing
  space, capitalisation), with *"Simple word replacement"* and *"Using GPT for
  instructional post-processing"* still sitting on the roadmap. The popular OSS
  baseline is thus LLM-free.
- **Handy** (Tauri, ~32k stars) — local Whisper plus optional LLM cleanup with
  Ollama as a local backend, and a community thread dedicated to sharing
  post-processing prompts (`discussions/715`).
- **VoiceInk** (macOS) — "Power Modes" (now "Modes"): a *prompt selected by
  context* (which app you're dictating into), plus optional AI enhancement.
- **Whispering** — frames the product as transcribe → **transform** → paste, i.e.
  the transform is a named, user-visible stage.
- **amical** — a "formatting prompt" containing explicit filler lists; an issue
  tracks that the list is English-only and omits Japanese fillers.
- **Resonant** (closed source, documented) — the only place I found the formal
  guard design: bad-prefix / coverage / novelty, with fallback to the raw
  transcript.

### 5.2 The patterns, distilled

1. **Layer it: deterministic first, LLM last.** Every project that ships
   something reliable does the mechanical work (filler lists, punctuation,
   spacing) without a model, and reserves the LLM for judgement.
2. **The prompts have converged.** Across Handy, Voxtype, amical and whisper
   plugins the rules are the same five: remove fillers (from an explicit list),
   fix punctuation/capitalisation, fix obvious ASR errors, preserve meaning,
   *output only the cleaned text*. Nobody's prompt is clever — the discipline is
   in the constraints, not the wording.
3. **The prompt is selected by context, not hardcoded** (VoiceInk modes,
   Resonant's email/message/general).
4. **Filler lists are language-specific** and a known localization trap.
5. **LLM cleanup is opt-in**, on top of a working LLM-free baseline.
6. **Latency is the universal weak spot.** Voxtype documents 2–5s; the others call
   a CLI or HTTP model synchronously with no streaming, no warm connection and no
   budget. *Nobody* I surveyed optimises TTFT or p99 — that is precisely the gap
   Wispr Flow's 700ms p99 fills (§2.1), and it is where PiNet can beat every
   open-source option while staying local-first.
7. **No OSS project that I surveyed implements formal anti-hallucination
   guards.** The closest is prompt-level restraint plus documentation warnings.
   The coverage/novelty guard design is documented only by a closed product —
   so building it (as pure, tested functions) is genuine differentiation, not a
   reimplementation.
8. **Raw transcripts are untrusted** — §4.2 is our own reproduction of an ASR
   hallucination on silence.

### 5.3 What to borrow, and what to reject

**Borrow:** the three-layer structure; a pluggable post-process step (Voxtype's
hook, but with a latency budget and a hard timeout instead of an unbounded shell
call); context/mode-specific prompts; explicit per-language filler lists; keeping
the LLM-free baseline working and fast.

**Reject:** the 2–5s synchronous CLI/HTTP call with no streaming; making the LLM
responsible for what a regex does deterministically; and trusting a raw
transcript as input.

---

## 6. Phases

- **P0 — measurement spike (no product code).** Record a handful of WAVs; benchmark
  Groq vs OpenAI vs local MLX ASR, and 2–3 cleanup models, **from the host**;
  measure p50/p95 per stage and the guard rejection rate on adversarial
  transcripts. Deliverable: a numbers table + provider decision. Cheap, and it
  de-risks every choice above.
- **P1 — capture + transport + raw transcript.** Mic button, AudioWorklet, VAD,
  `session.audio`, host op, insert-at-caret, undoable span. `PINET_VOICE` off by
  default. Already useful with no cleanup at all.
- **P2 — cleanup + guards + diff-patch + undo.**
- **P3 — tier-1 streaming partials, pause segmentation, hotword bias** (session
  cwd, recent identifiers, a user dictionary).
- **P4 — settings UI (provider/model/keys), correction learning, latency + cost
  telemetry.**

Each phase ships independently with tests and a doc update.

---

## 7. Security & privacy

- Audio is sealed end-to-end; the coordinator sees ciphertext and a byte count.
  The opacity invariant is preserved — no coordinator-side payload inspection.
- **Never logged, never persisted by default.** In-memory buffers, dropped after
  transcription. Opt-in `PINET_VOICE_KEEP_AUDIO` for debugging only.
- Add `maxPayload` + per-type frame caps to the coordinator, a per-session audio
  rate limit, and a max-utterance length (a hostile controller must not be able
  to make the host do unbounded work).
- Visible mic indicator; per-host enable switch; an explicit, in-product statement
  of where audio goes.
- **Cloud ASR means your voice leaves your machines.** That is a user decision,
  surfaced in settings — and the reason `local` is the preferred default when
  available.

---

## 8. Risks and open questions (decisions needed)

1. ~~**Cloud ASR key?**~~ **Resolved:** Groq, for both ASR
   (`whisper-large-v3-turbo`) and the cleanup pass (`qwen3.8-27b`) — one key, one
   vendor, both inside the latency budget (§4). Fireworks' Whisper was deprecated
   2026-06-10 (§2.3), and its LLMs measured 5–10× slower here.
2. **Install local ASR on the Macs?** whisper.cpp / parakeet-mlx (a few hundred MB)
   buys a fully private, license-free path. The VM cannot host it (no binaries,
   and no microphone near it).
3. **Is phone-first dictation required for v1?** Tier-1 partials are unreliable in
   iOS Safari, so a phone-first experience likely means accepting a slightly
   slower, audio-only path.
4. **Interaction:** hold-to-talk (keyboard shortcut / press-and-hold mic, as Wispr
   does) or tap-to-record with auto-stop on pause?
5. **How aggressive may the edit pass be?** Mechanics only (punctuation, filler,
   obvious ASR errors), or also restructuring — e.g. turning "first… second…"
   into a list when dictated?
6. **Non-goals for v1:** cloud streaming ASR (Deepgram-style), diarisation,
   multi-language code-switching, voice *commands* ("send it"), dictation in the
   TUI.

---

## 9. Testing strategy

- **Guards** — adversarial fixtures: an added sentence, a dropped number, a
  meta-commentary prefix, a "naturalised" technical term, empty input. Assert
  reject/accept and that the fallback path is taken.
- **Diff-patch** — never clobber concurrent user edits; replace the right span;
  undo restores exactly.
- **Transport** — a sealed audio frame reaches the host and decrypts; the relay
  path never sees plaintext (asserted, not assumed); byte caps enforce.
- **Latency** — a benchmark harness recording p50/p95 per stage against the P0
  baseline, so regressions are visible rather than felt.
- **Quality** — a small fixed set of (audio, expected text) pairs, scored for WER
  (ASR) and guard pass rate (cleanup).

---

## Sources

- Wispr Flow, *Technical challenges and breakthroughs behind Flow* — https://wisprflow.ai/post/technical-challenges
- Baseten, *Wispr Flow creates effortless voice dictation with Llama on Baseten* — https://www.baseten.co/resources/customers/wispr-flow/
- Resonant, *We Detect When AI Hallucinates Your Words* — https://www.onresonant.com/blog/hallucination-detection
- Fireworks, *20x faster Whisper than OpenAI* — https://fireworks.ai/blog/audio-transcription-launch (what it was; audio inference deprecated 2026-06-10 per https://docs.fireworks.ai/updates/changelog, and the endpoint 401s with a working account key)
- Groq, *Whisper Large v3 Turbo* — https://console.groq.com/docs/model/whisper-large-v3-turbo
- OpenAI, *Whisper prompting guide* — https://developers.openai.com/cookbook/examples/whisper_prompting_guide
- *Local Speech To Text on M5 Max: Whisper large-v3 vs Parakeet on MLX* — https://contracollective.com/blog/local-speech-to-text-whisper-parakeet-mlx-m5-max-2026
- Silero VAD in the browser — https://github.com/ricky0123/vad

### Prior-art sources (§5)

- Voxtype `CONFIGURATION.md` — https://github.com/peteonrails/voxtype/blob/main/docs/CONFIGURATION.md
- whisper-writer — https://github.com/savbell/whisper-writer
- Handy (and `discussions/715`, shared post-processing prompts) — https://github.com/cjpais/Handy
- VoiceInk modes — https://github.com/beingpax/VoiceInk
- Whispering — https://github.com/braden-w/whispering
- amical (formatting prompt / filler lists) — https://github.com/amicalhq/amical
- Deepgram filler-word handling — https://github.com/deepgram/recipes
- openchamber feature request, "AI cleanup/rewrite pass for dictation transcripts (Wispr Flow-style)" — https://github.com/openchamber/openchamber/issues/2114

---

## 10. What was actually built (and the decisions behind it)

Shipped as v0.11.0. The plan above proposed a layered pipeline with a
deterministic pre-pass; **that was dropped after testing**, on the user's call
and with the data to back it:

**The cleanup is a policy in the prompt, not code.** One LLM call at temperature
0 with the shipped ruleset, which encodes what would otherwise have been the
deterministic "C-series": the speaker's vocabulary, the spoken-command
conventions, the code/identifier conventions and the strict editing rules.

The test that settled it — messy dictation through the real model with the
shipped prompt:

```
in : "um so i want to add uh a rate limit to the the auth endpoint you know like
      100 requests per minute and uh rename get user underscore by id new line
      also the pin net coordinator talks to type script over gee it hub and i'm
      gonna wanna check it"
out: "So I want to add a rate limit to the auth endpoint, you know, like 100
      requests per minute, and rename get_user_by_id.
      Also, the PiNet coordinator talks to TypeScript over GitHub, and I'm gonna
      wanna check it."
```

✓ PiNet ✓ TypeScript ✓ GitHub ✓ get_user_by_id ✓ line break kept ✓ "gonna" kept
✓ 100 kept ✓ fillers gone. The model handles disfluency, stutters, doubled words
and self-corrections on its own — so those rules were redundant — and the one
thing it cannot do is *know* a proper noun (asked to clean "pin net" it wrote
"Pinnet"), which is why vocabulary is stated rather than inferred.

**Measured, real providers** (Groq `whisper-large-v3-turbo` + `qwen/qwen3.8-27b`):

| Step | Result |
|---|---|
| ASR | 525 KB / ~10 s of real speech → **340 ms**, transcript verbatim |
| Cleanup | **309 ms** for a 10-sentence transcript; output identical to input |
| Guard | coverage 1.00, novelty 0.00 — no invention on clean input |
| Policy cleanup | 232 ms, all eight policy checks pass |

Note the cleanup is proportional to output length: a 10-sentence take costs
~300 ms, a typical 3–5 s dictation closer to 100–150 ms.

**Two findings that changed the guard design.** It is advisory, and only `empty`
and `meta` block:

1. It *false-rejected correct output* when the vocabulary policy joins a term
   ("pin net" → "PiNet" loses tokens) — fixed by counting dots only inside a
   token, so a sentence-final period no longer corrupts the word.
2. It also false-rejects self-corrections, where dropping superseded words is
   right, so the thresholds are deliberately loose (coverage ≥ 0.3, novelty ≤ 0.5)
   and the flags surface in the UI as "check this one" rather than silently
   replacing the model's work.

**Still open:** the model kept "you know, like" in the transcript above. Keeping
"like" is defensible ("like 100" ≈ approximately 100) but "you know" at a clause
boundary is filler, so the prompt needs a sharper rule there. Pause-based
auto-stop (VAD) is also not implemented — recording is tap-to-start/stop, with
Escape to cancel.

**Architecture as shipped:** `session.audio` (sealed PCM chunks, controller →
host) and `session.voice` (sealed result) are relayed by the coordinator without
being read; each chunk is signed like a command and bound to the session/epoch/
index by AAD. The result is deliberately *not* echoed in the command ack, because
acks are plaintext at the coordinator and this is the user's speech.
