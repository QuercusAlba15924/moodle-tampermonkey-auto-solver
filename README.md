# Moodle AI Auto-Solver

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/Version-1.6.0-blue.svg)]()

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

- **Multi-Turn Retry Mechanism**: If the AI returns a valid answer but fails to format it correctly (e.g., missing `[x]` brackets), the script does not crash. It sends a **multi-turn request** back to the AI, showing its own failed response and providing a strict type-specific correction prompt.
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
3. **API Key**: Ensure you have a free [Google Gemini API Key](https://aistudio.google.com/). The script will prompt you for it on first run.

### GUI Configuration
The script injects a floating UI panel in the top-right corner of Moodle quizzes.
- **Primary & Fallback Models**: Seamlessly switch between models like `gemini-3.1-flash-lite` and `gemma-4-31b-it`.
- **Extra Context**: Inject specific knowledge (e.g., "This quiz is about Spring Framework Annotations") into the prompt dynamically.
- **Temperature Control**: Adjust the model's temperature (default `0.2`) to enforce strict formatting compliance without sacrificing reasoning capabilities.
- **Auto-Submit**: Toggle automatic test submission on the summary page.

### Troubleshooting
**Error: `Routine failed: Unexpected API Error: HTTP 404`**
If you see this error in the console after updating the script to a new version, it is likely because an outdated model name (e.g., `gemini-3.1-flash-lite-preview`) is still cached in your browser's local storage.
* **Fix**: Open the script's GUI panel on the Moodle page, change the **Primary** model to any other option, and then switch it back to your desired model. This simple toggle forces the script to overwrite the old cached configuration with the newly available model names.

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
