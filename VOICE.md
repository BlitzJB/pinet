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
| **Fireworks audio** | "1 hour of audio in 4 seconds" (2024 launch) | cheap | **endpoint is now deprecated** — litellm issue #30916 is titled *"Remove deprecated Fireworks AI audio transcriptions endpoint"*, and it no longer appears in Fireworks' docs index |
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

## 4. Latency budget

| Stage | Budget | Basis |
|---|---|---|
| capture + VAD + endpointing | ~0 | on-device, overlaps speech |
| audio → host | 45ms | measured one-way (India↔Europe) |
| ASR | 150ms (target <200) | to be measured in P0 |
| cleanup LLM | 250ms (TTFT ~120ms) | small fast model, streamed |
| result → browser | 45ms | measured |
| **total after release** | **~490ms** | p99 target <700ms |

With tier-1 partials the *perceived* latency is near zero; the number above is
what it takes for the text to become *correct*.

---

## 5. Phases

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

## 6. Security & privacy

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

## 7. Risks and open questions (decisions needed)

1. **Cloud ASR key?** Groq ($0.04/hr, built for real-time) vs OpenAI (stronger on
   noisy audio) vs none (local-only). Neither existing key (`deepseek`,
   `fireworks`) covers ASR, and Fireworks' endpoint is deprecated.
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

## 8. Testing strategy

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
- Fireworks, *20x faster Whisper than OpenAI* — https://fireworks.ai/blog/audio-transcription-launch (endpoint now deprecated: litellm#30916)
- Groq, *Whisper Large v3 Turbo* — https://console.groq.com/docs/model/whisper-large-v3-turbo
- OpenAI, *Whisper prompting guide* — https://developers.openai.com/cookbook/examples/whisper_prompting_guide
- *Local Speech To Text on M5 Max: Whisper large-v3 vs Parakeet on MLX* — https://contracollective.com/blog/local-speech-to-text-whisper-parakeet-mlx-m5-max-2026
- Silero VAD in the browser — https://github.com/ricky0123/vad
