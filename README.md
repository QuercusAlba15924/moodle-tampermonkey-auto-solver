# Moodle AI Auto-Solver

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/Version-1.7.0-blue.svg)]()

An advanced, context-aware Tampermonkey userscript that autonomously solves Moodle quizzes using Google Gemini AI. It features multi-turn error correction, sophisticated human-like interaction delays, and a modular architecture.

## Announcement

![](other/glory_to_ukraine.png)

Use this project only if:

- You **condemn Russia and its military aggression against Ukraine**
- You **recognize that Russia is an occupant that unlawfully invaded a sovereign state**
- You **support Ukraine's territorial integrity, including its claims over temporarily occupied territories of Crimea and Donbas**
- You **reject false narratives perpetuated by Russian state propaganda**

Otherwise, leave this project immediately

Putin idi nachui.

---

## Architecture & Universal Design

This script is built using strict **Separation of Concerns**. If Moodle changes its HTML structure, or if you want to port this solver to another LMS (like Canvas or Blackboard), you do **not** need to touch the AI logic.

The pipeline consists of three decoupled modules:

1. **`PageParser` (Data Extraction)**
   - The *only* module that knows about Moodle's DOM (`.que`, `.qtext`, `.answer`).
   - Parses the page and normalizes questions into a standard JSON object `{ type, subject, text, options, inputs }`.
2. **`AIClient` (Reasoning)**
   - Ignorant of the DOM. Takes the normalized JSON and constructs advanced prompts.
   - Handles multi-turn API calls, rate limits (429), and fallbacks (503).
3. **`UIManipulator` (Execution)**
   - Takes the AI's output array (e.g., `[0, 2]`) and interacts with the DOM elements found by the `PageParser`.
   - Simulates human behavior (scrolling, highlighting, delayed clicking).

### Extensibility: Porting to a new LMS
To adapt this script for a non-Moodle platform, you only need to rewrite the `PageParser.extractAllQuestions()` function to match the new platform's CSS selectors. The AI logic will adapt automatically.

---

## Advanced Prompt Engineering & AI

- **Multi-Turn Retry Mechanism**: If the AI returns a valid answer but fails to format it correctly (e.g., missing `[x]` brackets), the script does not crash. It sends a **multi-turn request** back to the AI, showing its own failed response and providing a strict type-specific correction prompt with dynamic validation feedback.
- **Anthropic-Style XML Tags**: Prompts are structured using explicit `<role>`, `<context>`, `<question>`, and `<output_format>` tags for maximum obedience.
- **Chain-of-Thought (CoT)**: The model is explicitly instructed to reason step-by-step *before* outputting the final indices, drastically reducing hallucination rates on complex questions.

---

## Supported Question Types
- **Single Choice** (Radio buttons)
- **Multiple Choice** (Checkboxes)
- **Matching / Ordering** (Dropdown selects)
- **Short Answer** (Text input matching)

---

## Installation & Usage

1. **Install a Userscript Manager**: Get [Tampermonkey](https://www.tampermonkey.net/).
2. **Add Script**: Copy the contents of `src/moodle-ai-solver.user.js` into a new Tampermonkey script.
3. **API Keys**: Ensure you have one or more free [Google Gemini API Keys](https://aistudio.google.com/). The script will prompt you for them on first run, or you can paste multiple keys in the GUI panel (one per line).

### GUI Configuration
The script injects a floating UI panel in the top-right corner of Moodle quizzes.
- **Primary & Fallback Models**: Choose from the modern model roster:
  - `gemini-3.5-flash-lite` *(Default Primary)*
  - `gemini-3.1-flash-lite` *(Default Fallback)*
  - `gemma-4-31b-it`
  - `gemma-4-26b-a4b-it`
  - `gemini-3.8-flash`
- **Multi-Key Management & Rotation**:
  - Configure multiple API keys in the textarea (one per line or comma-separated).
  - **Exhaust (`K1 -> K2`)**: Tests `K1(Primary) -> K1(Fallback) -> K2(Primary) -> K2(Fallback)...`. Automatically returns to Primary once its cooldown expires.
  - **Round-Robin (`Cycle`)**: Alternates starting keys across questions to balance load when solving multiple tests in parallel across 3+ browser tabs.
- **Adaptive Cooldowns & Exponential Backoff with Jitter**:
  - Rate limits (`429`) trigger adaptive cooldowns per `(key, model)` pair (`60s -> 300s -> 900s -> 3600s`).
  - Server overload (`503`) triggers a temporary 20s cooldown so the script immediately fails over to the Fallback model before returning to Primary.
  - If all available keys and models are saturated, the script enters an Exponential Backoff loop with jitter (`5s -> 10s -> 20s -> 40s -> 80s -> 120s`), displaying a live countdown in the status bar (`#ai-status-text`).
- **Extra Context**: Inject specific knowledge (e.g., "This quiz is about Spring Framework Annotations") into the prompt dynamically.
- **Temperature Control**: Adjust the model's temperature (default `0.2`) to enforce strict formatting compliance without sacrificing reasoning capabilities.
- **Auto-Submit**: Toggle automatic test submission on the summary page.

### Automatic Migration & Self-Healing
If you previously used an older version of the script, v1.7.0 automatically:
- Migrates your legacy single API key (`gemini_api_key`) into the new multi-key array (`CONFIG.API_KEYS`).
- Self-heals deprecated cached model names (e.g. `gemini-3.1-flash-lite-preview` -> `gemini-3.1-flash-lite`, `gemini-3.5-flash` -> `gemini-3.5-flash-lite`, or unknown names -> defaults) to prevent HTTP 404 errors.

---

## Developer Setup & Local Testing

A local Node.js test server is included to safely test the script against mock HTML templates without hitting real Moodle instances.

```bash
# Install dependencies
npm install

# Start the mock server
npm start
```
Navigate to `http://localhost:3000/tests/index.html` to access the testing dashboard.

### Model Discovery
To check which Google Generative AI models are currently available via the API, you can run the built-in discovery script. I also recommend checking the Rate Limits on the “Rate Limit” page in Google AI Studio before adding a model, if you're using the free API.
Ensure your `.env` file contains your `GEMINI_API_KEY`, then run:

```bash
npm run test-models
```

---

## Authors & Acknowledgments
- Concept, Testing, Implementation, and Improvements by **QuercusAlba15924**.
- Architecture, Refactoring, Main part of code, and Prompts, Docx and a lot more by **Antigravity AI** with Gemini 3.1 Pro, Gemini 3.0 Flash, and Claude 4.6 Opus Thinking.
