// ==UserScript==
// @name         Moodle AI Auto-Solver (High-Velocity & Context Aware)
// @namespace    http://tampermonkey.net/
// @version      1.7.0
// @description  Optimized Moodle solver with context awareness, forced delays, and modal auto-submit.
// @author       QuercusAlba15924
// @author       Gemini 3.1 Pro, Gemini 3.0 Flash, Claude 4.6 Opus Thinking, Gemini 3.8 Flash, Gemini 4 Argon
// @match        *://*/*mod/quiz/attempt.php*
// @match        *://*/*mod/quiz/summary.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      generativelanguage.googleapis.com
// ==/UserScript==

(function () {
    'use strict';


    let IS_PAUSED = false;

    const STORAGE_KEYS = {
        CONFIG: 'moodle_ai_config_v2',
        HISTORY: 'moodle_ai_history_v2',
        ERROR_LOG: 'moodle_ai_error_log',
        API: 'gemini_api_key',
        PAUSED: 'moodle_ai_paused_state',
        KEY_STATE: 'moodle_ai_key_state_v1'
    };

    const AVAILABLE_MODELS = [
        'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite',
        'gemma-4-31b-it',
        'gemma-4-26b-a4b-it',
        'gemini-3.8-flash'
    ];

    const MODEL_MIGRATION_MAP = {
        'gemini-3.5-flash': 'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite-preview': 'gemini-3.1-flash-lite'
    };

    const CONFIG = {
        MODEL: 'gemini-3.5-flash-lite',
        FALLBACK_MODEL: 'gemini-3.1-flash-lite',
        API_KEYS: [],
        KEY_STRATEGY: 'exhaust', // 'exhaust' | 'round_robin'
        EXTRA_CONTEXT: '',
        TEMPERATURE: 0.2,

        HIGHLIGHT_GREEN: true,
        BACKOFF_BASE_MS: 5000,     // 5s -> 10s -> 20s -> 40s -> 80s -> 120s
        BACKOFF_MAX_MS: 120000,    // Max 2 minutes per backoff wave
        MAX_BACKOFF_WAVES: 6,
        REQUEST_TIMEOUT_MS: 30000,
        MAX_PARSE_RETRIES: 2,
        MAX_ERROR_LOG_ENTRIES: 100,

        AUTO_SUBMIT_TEST: true,
        ENABLE_FORCED_DELAY: false,
        MIN_PAGE_TIME_SEC: 25,
        MAX_PAGE_TIME_SEC: 30,

        DELAY_READING_MIN: 1500,
        DELAY_READING_MAX: 3000,
        DELAY_DECIDING_MIN: 1000,
        DELAY_DECIDING_MAX: 2500,
        DELAY_BETWEEN_CLICKS_MIN: 300,
        DELAY_BETWEEN_CLICKS_MAX: 800,

        DELAY_SCROLL_FOCUS: 800,
        DELAY_BETWEEN_QUESTIONS_MIN: 1000,
        DELAY_BETWEEN_QUESTIONS_MAX: 2500,
        DELAY_NEXT_PAGE_MIN: 1500,
        DELAY_NEXT_PAGE_MAX: 3500,
        DELAY_SUBMIT_INITIAL_MIN: 1500,
        DELAY_SUBMIT_INITIAL_MAX: 3000,
        DELAY_MODAL_POLL: 500,
        DELAY_CONFIRM_FINAL_MIN: 500,
        DELAY_CONFIRM_FINAL_MAX: 1500
    };

    /**
     * AI Prompt Templates.
     *
     * Design principles:
     * - Chain-of-thought: model is allowed to reason freely, which improves accuracy.
     * - Strict output anchor: every prompt demands the LAST line be [x] format.
     * - Few-shot examples: concrete input→output pairs to ground the format.
     * - XML tags: clear section boundaries (Anthropic-style prompt engineering).
     *
     * Full prompt structure (assembled by _buildPrompt):
     * ┌──────────────────────────────────────────────────┐
     * │ <role>                                           │
     * │   PROMPTS.SYSTEM_ROLE                            │
     * │ </role>                                          │
     * │                                                  │
     * │ <context>                                        │
     * │   Subject: "Java Programming > OOP > Quiz: ..."  │
     * │   Quiz: "Blocks"                                 │
     * │   Additional Context: "Spring Framework basics"  │  ← only if CONFIG.EXTRA_CONTEXT is set
     * │ </context>                                       │
     * │                                                  │
     * │ <question type="radio">                          │
     * │   ArrayList belongs to the package:              │
     * │ </question>                                      │
     * │                                                  │
     * │ <options>                                        │
     * │   [Index 0] java.util                            │
     * │   [Index 1] java.lang                            │
     * │   ...                                            │
     * │ </options>                                       │
     * │                                                  │
     * │ <instructions>                                   │
     * │   PROMPTS.TYPE_SINGLE (or TYPE_MULTIPLE, etc.)   │
     * │ </instructions>                                  │
     * │                                                  │
     * │ <output_format>                                  │
     * │   PROMPTS.FORMAT_INDICES (with few-shot examples)│
     * │ </output_format>                                 │
     * └──────────────────────────────────────────────────┘
     */
    const PROMPTS = {
        SYSTEM_ROLE: `You are an expert university professor. Your task is to determine the correct answer for the student's test question.`,

        // --- Type-specific instructions ---
        TYPE_SINGLE: `This is a SINGLE-CHOICE question. Exactly one option is correct.`,
        TYPE_MULTIPLE: `This is a MULTIPLE-CHOICE question. One or more options may be correct. Select ALL that apply.`,
        TYPE_MATCHING: `This is a MATCHING question. For each dropdown, determine which choice correctly matches the given item.`,
        TYPE_SHORTANSWER: `This is a SHORT ANSWER question. Determine the exact text that should be entered.`,

        // --- Output format instructions (chain-of-thought allowed) ---
        FORMAT_INDICES: [
            `You may reason step-by-step to arrive at the correct answer.`,
            `However, the LAST line of your response MUST contain ONLY the answer indices in square brackets.`,
            `Indices are 0-based.`,
            ``,
            `<examples>`,
            `Example 1 (single-choice, correct is option 2):`,
            `The answer is clearly option 2 because...`,
            `[2]`,
            ``,
            `Example 2 (multiple-choice, correct are options 0 and 3):`,
            `Options 0 and 3 are correct because...`,
            `[0, 3]`,
            `</examples>`,
        ].join('\n'),

        FORMAT_MATCHING: [
            `You may reason step-by-step to determine the correct matches.`,
            `However, the LAST line of your response MUST contain ONLY a JSON array of indices in dropdown order.`,
            `Each index is 0-based relative to that dropdown's choice list.`,
            ``,
            `<examples>`,
            `Example (3 dropdowns): After analysis, the matches are...`,
            `[1, 0, 3]`,
            `</examples>`,
        ].join('\n'),

        FORMAT_SHORTANSWER: [
            `You may reason step-by-step to determine the answer.`,
            `However, the LAST line of your response MUST contain ONLY the final answer text using this exact format: FINAL_ANSWER: [Your Answer Here]`,
            ``,
            `<examples>`,
            `Example: The capital of France is Paris.`,
            `FINAL_ANSWER: [Paris]`,
            `</examples>`,
        ].join('\n'),

        // --- Retry corrections (sent as 3rd message in multi-turn) ---
        RETRY_INDICES: [
            `Your response above could NOT be parsed because it did not contain the answer in [x] format.`,
            ``,
            `Look at your own analysis above and extract the correct answer index.`,
            `Respond with ONLY the index in square brackets. Nothing else.`,
            ``,
            `WRONG (do NOT repeat these mistakes):`,
            `  "The answer is option 0"    — no brackets`,
            `  "Index: 0"                  — no brackets`,
            `  "Correct: java.util"        — text instead of index`,
            ``,
            `CORRECT (respond exactly like this):`,
            `  [0]         — single-choice`,
            `  [0, 2]      — multiple-choice`,
        ].join('\n'),

        RETRY_MATCHING: [
            `Your response above could NOT be parsed. It did not end with a JSON array of indices.`,
            ``,
            `Look at your own analysis above and extract the correct match indices.`,
            `Respond with ONLY the array. Nothing else.`,
            ``,
            `CORRECT format: [1, 0, 3]`,
        ].join('\n'),

        RETRY_SHORTANSWER: [
            `Your response above could NOT be parsed. It did not contain the answer in the required FINAL_ANSWER: [text] format.`,
            ``,
            `Look at your own analysis above and extract the answer.`,
            `Respond with ONLY the final answer line in this exact format:`,
            `FINAL_ANSWER: [Paris]`,
        ].join('\n'),
    };

    // Polyfills for GM_ functions to allow the script to run in a normal browser tab for testing
    const GM_Wrapper = {
        getValue: (key, defaultValue) => {
            let val;
            if (typeof GM_getValue !== 'undefined') val = GM_getValue(key, defaultValue);
            else if (typeof localStorage !== 'undefined') {
                const raw = localStorage.getItem(key);
                val = raw !== null ? raw : defaultValue;
            } else {
                val = defaultValue;
            }

            if (val === undefined || val === null) return defaultValue;
            if (typeof val === 'string') {
                try {
                    return JSON.parse(val);
                } catch (e) {
                    return val;
                }
            }
            return val;
        },
        setValue: (key, value) => {
            if (typeof GM_setValue !== 'undefined') {
                GM_setValue(key, value);
            } else if (typeof localStorage !== 'undefined') {
                const strValue = typeof value === 'string' ? value : JSON.stringify(value);
                localStorage.setItem(key, strValue);
            }
        }
    };

    const Logger = {
        info: (msg) => console.log(`%c[AI-Solver] %c${msg}`, 'color: #00a8ff; font-weight: bold;', 'color: inherit;'),
        warn: (msg) => console.warn(`[AI-Solver WARNING] ${msg}`),
        error: (msg) => console.error(`[AI-Solver ERROR] ${msg}`),

        persistHistory: (questionData, aiRawResponse, parsedIndexes) => {
            try {
                const history = GM_Wrapper.getValue(STORAGE_KEYS.HISTORY, {});

                const groupKey = `[${questionData.subject}] ${questionData.title}`;
                if (!history[groupKey]) {
                    history[groupKey] = [];
                }

                history[groupKey].push({
                    timestamp: new Date().toISOString(),
                    questionText: questionData.text,
                    optionsAvailable: questionData.options,
                    aiOutput: aiRawResponse,
                    indexesSelected: parsedIndexes
                });

                GM_Wrapper.setValue(STORAGE_KEYS.HISTORY, history);
            } catch (err) {
                console.error("[AI-Solver ERROR] Persistence failure", err);
            }
        },

        persistError: ({ questionData, errorMessage, model, aiRawResponse, attempt }) => {
            try {
                const errors = GM_Wrapper.getValue(STORAGE_KEYS.ERROR_LOG, []);
                errors.push({
                    timestamp: new Date().toISOString(),
                    url: window.location.href,
                    pageTitle: document.title,
                    model: model,
                    fallbackModel: CONFIG.FALLBACK_MODEL,
                    attempt: attempt,
                    questionType: questionData?.type,
                    questionSubject: questionData?.subject,
                    questionText: questionData?.text,
                    optionsCount: questionData?.options?.length ?? 0,
                    options: questionData?.options,
                    errorMessage: errorMessage,
                    aiRawResponse: aiRawResponse || null,
                });

                while (errors.length > CONFIG.MAX_ERROR_LOG_ENTRIES) {
                    errors.shift();
                }

                GM_Wrapper.setValue(STORAGE_KEYS.ERROR_LOG, errors);
            } catch (err) {
                console.error('[AI-Solver] Failed to persist error log:', err);
            }
        }
    };

    const Utils = {
        getRandomDelay: (min, max) => Math.floor(Math.random() * (max - min + 1) + min),
        sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

        setStatus: (text, color = '#94a3b8') => {
            const el = document.getElementById('ai-status-text');
            if (el) {
                el.innerText = text;
                el.style.color = color;
            }
        },

        getValidSelectOptions: (selectNode) => {
            return Array.from(selectNode.options).filter(opt => {
                const val = opt.value !== undefined ? String(opt.value).trim() : '';
                const text = (opt.innerText || opt.textContent || '').trim();
                return val !== '' && val !== '0' && val !== '-1' && !opt.disabled && text !== '';
            });
        },

        sleepWithCountdown: async (totalMs, labelPrefix = 'Waiting') => {
            let remainingMs = totalMs;
            while (remainingMs > 0) {
                while (IS_PAUSED) {
                    Utils.setStatus('PAUSED', '#eab308');
                    await Utils.sleep(500);
                }
                const secs = Math.ceil(remainingMs / 1000);
                Utils.setStatus(`${labelPrefix}: ${secs}s...`, '#f59e0b');
                const step = Math.min(1000, remainingMs);
                await Utils.sleep(step);
                remainingMs -= step;
            }
        },

        parseKeysInput: (rawText) => {
            if (!rawText) return [];
            if (Array.isArray(rawText)) {
                return rawText.map(k => String(k).trim()).filter(Boolean);
            }
            return String(rawText)
                .split(/[\n,;]+/)
                .map(k => k.trim())
                .filter(Boolean);
        },

        loadConfig: () => {
            const saved = GM_Wrapper.getValue(STORAGE_KEYS.CONFIG, {});
            for (const key of Object.keys(saved)) {
                if (key in CONFIG) {
                    CONFIG[key] = saved[key];
                }
            }

            // 1. Auto-migrate deprecated model names
            if (MODEL_MIGRATION_MAP[CONFIG.MODEL]) {
                CONFIG.MODEL = MODEL_MIGRATION_MAP[CONFIG.MODEL];
            }
            if (MODEL_MIGRATION_MAP[CONFIG.FALLBACK_MODEL]) {
                CONFIG.FALLBACK_MODEL = MODEL_MIGRATION_MAP[CONFIG.FALLBACK_MODEL];
            }
            if (!AVAILABLE_MODELS.includes(CONFIG.MODEL)) {
                Logger.warn(`Deprecated primary model "${CONFIG.MODEL}" in storage. Resetting to default.`);
                CONFIG.MODEL = 'gemini-3.5-flash-lite';
            }
            if (!AVAILABLE_MODELS.includes(CONFIG.FALLBACK_MODEL)) {
                Logger.warn(`Deprecated fallback model "${CONFIG.FALLBACK_MODEL}" in storage. Resetting to default.`);
                CONFIG.FALLBACK_MODEL = 'gemini-3.1-flash-lite';
            }

            // 2. Normalize & Auto-migrate legacy single API key into CONFIG.API_KEYS
            CONFIG.API_KEYS = Utils.parseKeysInput(CONFIG.API_KEYS);
            const legacyKey = GM_Wrapper.getValue(STORAGE_KEYS.API, '');
            if (CONFIG.API_KEYS.length === 0 && legacyKey && typeof legacyKey === 'string' && legacyKey.trim()) {
                CONFIG.API_KEYS = Utils.parseKeysInput(legacyKey);
                Logger.info('Migrated legacy API key to multi-key storage.');
            }

            Utils.saveConfig();
        },

        saveConfig: () => {
            GM_Wrapper.setValue(STORAGE_KEYS.CONFIG, CONFIG);
            // Keep first key in legacy slot for backward compatibility
            if (CONFIG.API_KEYS.length > 0) {
                GM_Wrapper.setValue(STORAGE_KEYS.API, CONFIG.API_KEYS[0]);
            }
        },

        ensureApiKeys: () => {
            if (CONFIG.API_KEYS && CONFIG.API_KEYS.length > 0) {
                return CONFIG.API_KEYS;
            }
            const input = prompt('Moodle AI Solver Initialization:\nPlease provide one or more Google Gemini API Keys (comma or newline separated):');
            const parsed = Utils.parseKeysInput(input);
            if (parsed.length > 0) {
                CONFIG.API_KEYS = parsed;
                Utils.saveConfig();
                const keysTextarea = document.getElementById('cfg-keys');
                if (keysTextarea) keysTextarea.value = parsed.join('\n');
                return CONFIG.API_KEYS;
            }
            throw new Error('No API keys provided.');
        }
    };

    const PageParser = {
        extractAllQuestions: () => {
            // Extract Detailed Context (Breadcrumbs)
            const breadcrumbItems = Array.from(document.querySelectorAll('.breadcrumb-item:not([aria-current="page"])'));
            const breadcrumbContext = breadcrumbItems
                .map(item => item.innerText.trim())
                .filter(t => t && t !== 'Home' && t !== 'Dashboard' && t !== 'My courses')
                .join(' > ');

            // Extract Course Name
            const headerNode = document.querySelector('#page-header h1');
            const courseTitle = headerNode ? headerNode.innerText.trim() : '';

            // Combine into a rich subject name
            let subjectName = breadcrumbContext;
            if (courseTitle && !subjectName.includes(courseTitle)) {
                subjectName = courseTitle + (subjectName ? ' > ' + subjectName : '');
            }
            if (!subjectName) subjectName = 'Unknown Subject';

            // Extract Quiz Title (Global context)
            const titleNode = document.querySelector('#maincontent + h2') || document.querySelector('h2');
            const quizTitle = titleNode ? titleNode.innerText.trim() : 'Unknown Quiz';

            // Find all question blocks (.que is the standard Moodle class for questions)
            const questionBlocks = Array.from(document.querySelectorAll('.que'));
            if (!questionBlocks.length) return [];

            return questionBlocks.map(block => {
                const questionContainer = block.querySelector('.qtext');
                if (!questionContainer) return null;

                const rawQuestionText = (questionContainer.innerText || questionContainer.textContent || '').trim();
                const questionText = rawQuestionText.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');

                // Find all possible input methods within THIS specific block
                const selectNodes = Array.from(block.querySelectorAll('.answer select'));
                const inputNodes = Array.from(block.querySelectorAll('.answer input[type="radio"]:not([value="-1"]), .answer input[type="checkbox"]'));

                if (selectNodes.length > 0) {
                    // TYPE: Matching / Ordering
                    const structuredOptions = selectNodes.map((selectNode, index) => {
                        const tr = selectNode.closest('tr');
                        const textNode = tr ? tr.querySelector('.text') : selectNode.parentElement;
                        const itemText = textNode ? textNode.innerText.trim() : `Item ${index + 1}`;

                        // Filter out default empty/prompt options (placeholders)
                        const validOptions = Utils.getValidSelectOptions(selectNode);
                        const opts = validOptions.map(opt => (opt.innerText || opt.textContent || '').trim());

                        return `[Dropdown ${index}] Match this item: "${itemText}" | Choices count: ${opts.length} | Choices list (indices 0 to ${opts.length - 1}): [${opts.join(', ')}]`;
                    });

                    return {
                        block: block, // Store reference for UI effects
                        type: 'select',
                        subject: subjectName,
                        title: quizTitle,
                        text: questionText,
                        options: structuredOptions,
                        inputs: selectNodes
                    };
                }
                else if (inputNodes.length > 0) {
                    // TYPE: Checkbox / Radio
                    const isMultipleChoice = inputNodes[0].type === 'checkbox';
                    const structuredOptions = inputNodes.map((inputNode, index) => {
                        const labelWrapper = inputNode.closest('div').querySelector('.flex-fill');
                        const optionText = labelWrapper ? labelWrapper.innerText.trim() : inputNode.parentElement.innerText.trim();
                        return `[Index ${index}] ${optionText}`;
                    });

                    return {
                        block: block,
                        type: isMultipleChoice ? 'checkbox' : 'radio',
                        subject: subjectName,
                        title: quizTitle,
                        text: questionText,
                        options: structuredOptions,
                        inputs: inputNodes
                    };
                }

                const textInputNodes = Array.from(block.querySelectorAll('.answer input[type="text"]'));
                if (textInputNodes.length > 0) {
                    // TYPE: Shortanswer (Text input)
                    return {
                        block: block,
                        type: 'shortanswer',
                        subject: subjectName,
                        title: quizTitle,
                        text: questionText,
                        options: [],
                        inputs: textInputNodes
                    };
                }

                return null; // Unsupported question type or no inputs found in block
            }).filter(q => q !== null);
        }
    };

    // IMPORTANT: Use fetch instead of GM_xmlhttpRequest to avoid error 503 (service unavaliable).

    const KeyManager = {
        _maskKey: (key) => key.length > 8 ? `...${key.slice(-4)}` : 'key',

        _getState: () => {
            return GM_Wrapper.getValue(STORAGE_KEYS.KEY_STATE, {
                roundRobinIndex: 0,
                invalidKeys: {}, // { [apiKey]: timestamp }
                pairs: {}        // { ["apiKey::model"]: { cooldownUntil: 0, strikes: 0 } }
            });
        },

        _saveState: (state) => {
            GM_Wrapper.setValue(STORAGE_KEYS.KEY_STATE, state);
        },

        _pairId: (apiKey, modelName) => `${apiKey}::${modelName}`,

        markSuccess: (apiKey, modelName) => {
            const state = KeyManager._getState();
            const pid = KeyManager._pairId(apiKey, modelName);
            if (state.pairs && state.pairs[pid]) {
                state.pairs[pid].strikes = 0;
                state.pairs[pid].cooldownUntil = 0;
                KeyManager._saveState(state);
            }
        },

        markRateLimited: (apiKey, modelName) => {
            const state = KeyManager._getState();
            const pid = KeyManager._pairId(apiKey, modelName);
            state.pairs = state.pairs || {};
            const current = state.pairs[pid] || { strikes: 0, cooldownUntil: 0 };
            current.strikes += 1;

            // Adaptive cooldown: 1m (RPM) -> 5m -> 15m -> 60m (RPD exhausted)
            const scheduleSec = [60, 300, 900, 3600];
            const durationSec = scheduleSec[Math.min(current.strikes - 1, scheduleSec.length - 1)];
            current.cooldownUntil = Date.now() + durationSec * 1000;

            state.pairs[pid] = current;
            KeyManager._saveState(state);
            Logger.warn(`Rate limit (429) on Key(${KeyManager._maskKey(apiKey)}) + [${modelName}]. Cooldown: ${durationSec}s (Strike ${current.strikes}).`);
        },

        markServerOverloaded: (apiKey, modelName) => {
            const state = KeyManager._getState();
            const pid = KeyManager._pairId(apiKey, modelName);
            state.pairs = state.pairs || {};
            const current = state.pairs[pid] || { strikes: 0, cooldownUntil: 0 };
            // Short 20s cooldown on 503/timeout so script immediately tries Fallback, then returns to Primary later
            current.cooldownUntil = Date.now() + 20000;
            state.pairs[pid] = current;
            KeyManager._saveState(state);
            Logger.warn(`Server overloaded/timeout (503) on Key(${KeyManager._maskKey(apiKey)}) + [${modelName}]. Temporary 20s cooldown.`);
        },

        markKeyInvalid: (apiKey, status) => {
            const state = KeyManager._getState();
            state.invalidKeys = state.invalidKeys || {};
            // Ban invalid/revoked key for 1 hour
            state.invalidKeys[apiKey] = Date.now() + 3600 * 1000;
            KeyManager._saveState(state);
            Logger.error(`Key(${KeyManager._maskKey(apiKey)}) returned HTTP ${status} (Invalid/Forbidden). Disabling key.`);
        },

        /**
         * Builds the ordered execution plan of { apiKey, keyIndex, modelName } pairs:
         * K_start(Primary) -> K_start(Fallback) -> K_next(Primary) -> K_next(Fallback)...
         */
        buildExecutionPlan: (ignoreCooldowns = false, advanceRoundRobin = false) => {
            const keys = Utils.ensureApiKeys();
            const state = KeyManager._getState();
            const now = Date.now();

            let startIndex = 0;
            if (CONFIG.KEY_STRATEGY === 'round_robin' && keys.length > 1) {
                startIndex = (state.roundRobinIndex || 0) % keys.length;
                if (advanceRoundRobin) {
                    state.roundRobinIndex = (startIndex + 1) % keys.length;
                    KeyManager._saveState(state);
                }
            }

            const models = [CONFIG.MODEL];
            if (CONFIG.FALLBACK_MODEL && CONFIG.FALLBACK_MODEL !== CONFIG.MODEL) {
                models.push(CONFIG.FALLBACK_MODEL);
            }

            const plan = [];
            for (let offset = 0; offset < keys.length; offset++) {
                const keyIdx = (startIndex + offset) % keys.length;
                const apiKey = keys[keyIdx];

                // Skip globally invalid keys unless all keys were marked invalid
                if (state.invalidKeys && state.invalidKeys[apiKey] && state.invalidKeys[apiKey] > now) {
                    continue;
                }

                for (const modelName of models) {
                    const pid = KeyManager._pairId(apiKey, modelName);
                    const pairState = state.pairs && state.pairs[pid];
                    const isCoolingDown = pairState && pairState.cooldownUntil > now;

                    if (!isCoolingDown || ignoreCooldowns) {
                        plan.push({
                            apiKey,
                            keyIndex: keyIdx + 1,
                            totalKeys: keys.length,
                            modelName
                        });
                    }
                }
            }

            return plan;
        }
    };

    const AIClient = {
        _buildPrompt: (q) => {
            const role = `<role>\n${PROMPTS.SYSTEM_ROLE}\n</role>\n\n`;

            let context = `<context>\nSubject: "${q.subject}"\nQuiz: "${q.title}"\n`;
            if (CONFIG.EXTRA_CONTEXT && CONFIG.EXTRA_CONTEXT.trim()) {
                context += `Additional Context: "${CONFIG.EXTRA_CONTEXT.trim()}"\n`;
            }
            context += `</context>\n\n`;

            const questionText = `<question type="${q.type}">\n${q.text}\n</question>\n\n`;

            let optionsText = "";
            if (q.options && q.options.length > 0) {
                optionsText = "<options>\n" + q.options.join('\n') + "\n</options>\n\n";
            }

            let typeInstruction = "";
            let formatInstruction = "";

            if (q.type === 'select') {
                typeInstruction = `<instructions>\n${PROMPTS.TYPE_MATCHING}\n</instructions>\n\n`;
                formatInstruction = `<output_format>\n${PROMPTS.FORMAT_MATCHING}\n</output_format>`;
            } else if (q.type === 'checkbox') {
                typeInstruction = `<instructions>\n${PROMPTS.TYPE_MULTIPLE}\n</instructions>\n\n`;
                formatInstruction = `<output_format>\n${PROMPTS.FORMAT_INDICES}\n</output_format>`;
            } else if (q.type === 'shortanswer') {
                typeInstruction = `<instructions>\n${PROMPTS.TYPE_SHORTANSWER}\n</instructions>\n\n`;
                formatInstruction = `<output_format>\n${PROMPTS.FORMAT_SHORTANSWER}\n</output_format>`;
            } else {
                typeInstruction = `<instructions>\n${PROMPTS.TYPE_SINGLE}\n</instructions>\n\n`;
                formatInstruction = `<output_format>\n${PROMPTS.FORMAT_INDICES}\n</output_format>`;
            }

            return `${role}${context}${questionText}${optionsText}${typeInstruction}${formatInstruction}`;
        },

        _buildRetryContents: (originalPrompt, failedResponse, questionType, validationErrorMsg = '') => {
            let retryMessage;
            if (questionType === 'select') retryMessage = PROMPTS.RETRY_MATCHING;
            else if (questionType === 'shortanswer') retryMessage = PROMPTS.RETRY_SHORTANSWER;
            else retryMessage = PROMPTS.RETRY_INDICES;

            const errorContext = validationErrorMsg
                ? `<validation_error>\nYour previous response failed validation with the following exact error:\n"${validationErrorMsg}"\n</validation_error>\n\n`
                : '';

            return [
                { role: 'user', parts: [{ text: originalPrompt }] },
                { role: 'model', parts: [{ text: String(failedResponse || '') }] },
                { role: 'user', parts: [{ text: `${errorContext}${retryMessage}` }] },
            ];
        },

        _callModel: async (modelName, contents, apiKey) => {
            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
            const payload = {
                contents,
                generationConfig: { temperature: parseFloat(CONFIG.TEMPERATURE) || 0.2 }
            };

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

            try {
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });

                if (response.status === 200) {
                    const responseData = await response.json();
                    const candidate = responseData.candidates?.[0];
                    const parts = candidate?.content?.parts;

                    if (!parts || !Array.isArray(parts) || parts.length === 0) {
                        const reason = candidate?.finishReason || 'UNKNOWN';
                        return { ok: false, status: 503, reason: `Empty AI response (finishReason: ${reason})` };
                    }

                    // Filter out thinking parts if model returns thought tokens
                    const nonThoughtParts = parts.filter(p => !p.thought && typeof p.text === 'string');
                    const textParts = nonThoughtParts.length > 0 ? nonThoughtParts : parts.filter(p => typeof p.text === 'string');
                    const finalText = textParts.map(p => p.text).join('\n').trim();

                    if (!finalText) {
                        return { ok: false, status: 503, reason: 'Empty text in AI response parts' };
                    }

                    return { ok: true, text: finalText };
                }

                return { ok: false, status: response.status };
            } catch (err) {
                if (err.name === 'AbortError') {
                    return { ok: false, status: 503, reason: 'Request timed out' };
                }
                return { ok: false, status: 503, reason: err.message || 'Network error' };
            } finally {
                clearTimeout(timeoutId);
            }
        },

        evaluateQuestion: async (questionData) => {
            const prompt = AIClient._buildPrompt(questionData);
            const contents = [{ role: 'user', parts: [{ text: prompt }] }];
            return await AIClient._executeWithResilience(contents);
        },

        evaluateQuestionRetry: async (questionData, originalPrompt, failedResponse, validationErrorMsg) => {
            const contents = AIClient._buildRetryContents(originalPrompt, failedResponse, questionData.type, validationErrorMsg);
            return await AIClient._executeWithResilience(contents);
        },

        /**
         * Executes the request across Key_i(Primary) -> Key_i(Fallback) -> Key_{i+1}(Primary)...
         * If all pairs fail (429 / 503), enters Exponential Backoff (5s -> 10s -> 20s -> 40s -> 80s -> 120s + Jitter).
         */
        _executeWithResilience: async (contents) => {
            let lastStatus = null;

            for (let wave = 0; wave <= CONFIG.MAX_BACKOFF_WAVES; wave++) {
                if (wave > 0) {
                    const expDelay = Math.min(
                        CONFIG.BACKOFF_MAX_MS,
                        CONFIG.BACKOFF_BASE_MS * Math.pow(2, wave - 1)
                    );
                    const jitter = Utils.getRandomDelay(0, 3000);
                    const totalWaitMs = expDelay + jitter;

                    Logger.warn(`All Key+Model pairs busy/overloaded (last status: ${lastStatus}). Exponential Backoff Wave ${wave}/${CONFIG.MAX_BACKOFF_WAVES}: waiting ${(totalWaitMs / 1000).toFixed(1)}s...`);
                    await Utils.sleepWithCountdown(totalWaitMs, `Backoff W${wave}/${CONFIG.MAX_BACKOFF_WAVES}`);
                }

                // On wave 0, respect active cooldowns; if all pairs are currently on cooldown, or on wave > 0, force-test them
                let plan = KeyManager.buildExecutionPlan(wave > 0, wave === 0);
                if (plan.length === 0) {
                    // All pairs are currently on cooldown during wave 0 -> jump straight to wave 1 backoff,
                    // or if we want to try after backoff, continue to next wave
                    lastStatus = 'ALL_COOLING_DOWN';
                    continue;
                }

                for (const step of plan) {
                    while (IS_PAUSED) {
                        Utils.setStatus('PAUSED', '#eab308');
                        await Utils.sleep(500);
                    }

                    Utils.setStatus(`Key ${step.keyIndex}/${step.totalKeys} [${step.modelName}]`, '#38bdf8');
                    const result = await AIClient._callModel(step.modelName, contents, step.apiKey);

                    if (result.ok) {
                        KeyManager.markSuccess(step.apiKey, step.modelName);
                        Utils.setStatus(`OK: K${step.keyIndex} [${step.modelName}]`, '#10b981');
                        return result.text;
                    }

                    lastStatus = result.status;

                    if (result.status === 429) {
                        KeyManager.markRateLimited(step.apiKey, step.modelName);
                        continue; // Immediately try next pair in plan (e.g. Fallback on same key, or Primary on next key)
                    }

                    if (result.status === 503 || result.status >= 500) {
                        KeyManager.markServerOverloaded(step.apiKey, step.modelName);
                        continue; // Immediately try Fallback model or next key
                    }

                    if (result.status === 400 || result.status === 403) {
                        KeyManager.markKeyInvalid(step.apiKey, result.status);
                        continue; // Key is broken, try next key
                    }

                    if (result.status === 404) {
                        Logger.warn(`Model ${step.modelName} returned 404. Trying next option in plan...`);
                        KeyManager.markServerOverloaded(step.apiKey, step.modelName);
                        continue;
                    }
                }
            }

            Utils.setStatus('API Exhausted', '#ef4444');
            throw new Error(`All API keys and models failed after ${CONFIG.MAX_BACKOFF_WAVES} backoff waves (Last status: ${lastStatus}).`);
        }
    };

    const UIManipulator = {
        applySelection: async (questionData, aiResponseText) => {
            if (questionData.type === 'shortanswer') {
                const matches = Array.from(aiResponseText.matchAll(/FINAL_ANSWER:\s*\[(.+)\]\s*$/gm));
                if (matches.length === 0) {
                    Logger.error("Parsing failure. AI output didn't contain FINAL_ANSWER: [x]: " + aiResponseText);
                    throw new Error('Validation Error: Response did not end with the required format "FINAL_ANSWER: [Your Answer]".');
                }

                const parsedAnswer = matches[matches.length - 1][1].trim();
                if (!parsedAnswer) {
                    throw new Error('Validation Error: The brackets inside FINAL_ANSWER: [] were empty.');
                }

                Logger.info(`Applying shortanswer text: "${parsedAnswer}"`);

                const targetInput = questionData.inputs[0];
                if (targetInput) {
                    targetInput.value = parsedAnswer;
                    targetInput.dispatchEvent(new Event('input', { bubbles: true }));
                    targetInput.dispatchEvent(new Event('change', { bubbles: true }));

                    if (CONFIG.HIGHLIGHT_GREEN) {
                        targetInput.style.transition = 'all 0.4s cubic-bezier(0.165, 0.84, 0.44, 1)';
                        targetInput.style.backgroundColor = 'rgba(16, 185, 129, 0.15)';
                        targetInput.style.border = '2px solid #10b981';
                    }
                }
                return [parsedAnswer];
            }

            // Find all bracketed numeric index patterns (supports spaces like [ 0 ] or [ 1, 2 ])
            const matches = aiResponseText.match(/\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/g);
            if (!matches) {
                Logger.error("Parsing failure. AI output didn't contain valid indices: " + aiResponseText);
                throw new Error('Validation Error: No bracketed index array like [0] or [0, 2] was found at the end of your response.');
            }

            const lastMatchText = matches[matches.length - 1];
            const contentMatch = lastMatchText.match(/\[\s*(.*?)\s*\]/);
            const innerContent = contentMatch ? contentMatch[1] : "";

            const parsedAnswers = innerContent
                .split(',')
                .map(s => parseInt(s.trim(), 10))
                .filter(n => !isNaN(n) && n >= 0);

            if (parsedAnswers.length === 0) {
                throw new Error('Validation Error: Parsed index array was empty or contained invalid numbers.');
            }

            // TYPE 1: Matching / Select Dropdowns
            if (questionData.type === 'select') {
                const selectNodes = questionData.inputs;
                if (parsedAnswers.length !== selectNodes.length) {
                    throw new Error(
                        `Validation Error: This matching question has exactly ${selectNodes.length} dropdowns, so your array MUST contain ${selectNodes.length} indices. However, you returned ${parsedAnswers.length} indices: [${parsedAnswers.join(', ')}].`
                    );
                }

                // Pre-validate every dropdown's option index BEFORE mutating DOM
                const resolvedSelections = selectNodes.map((targetSelect, i) => {
                    const validOptions = Utils.getValidSelectOptions(targetSelect);
                    const chosenIndex = parsedAnswers[i];
                    if (chosenIndex < 0 || chosenIndex >= validOptions.length) {
                        throw new Error(
                            `Validation Error: Dropdown #${i} only has ${validOptions.length} valid choices (0-based indices 0 to ${validOptions.length - 1}), but you provided index ${chosenIndex} in [${parsedAnswers.join(', ')}].`
                        );
                    }
                    return { targetSelect, optionToSelect: validOptions[chosenIndex] };
                });

                Logger.info(`Applying matching selections: ${JSON.stringify(parsedAnswers)}`);

                for (let i = 0; i < resolvedSelections.length; i++) {
                    const { targetSelect, optionToSelect } = resolvedSelections[i];
                    targetSelect.value = optionToSelect.value;
                    targetSelect.dispatchEvent(new Event('change', { bubbles: true }));

                    if (CONFIG.HIGHLIGHT_GREEN) {
                        const styleWrapper = targetSelect.closest('.r0, .r1') || targetSelect.parentElement;
                        if (styleWrapper) {
                            styleWrapper.style.transition = 'all 0.4s cubic-bezier(0.165, 0.84, 0.44, 1)';
                            styleWrapper.style.backgroundColor = 'rgba(16, 185, 129, 0.15)';
                            styleWrapper.style.borderLeft = '4px solid #10b981';
                            styleWrapper.style.paddingLeft = '10px';
                        }
                    }

                    if (i < resolvedSelections.length - 1) {
                        const jitter = Utils.getRandomDelay(CONFIG.DELAY_BETWEEN_CLICKS_MIN, CONFIG.DELAY_BETWEEN_CLICKS_MAX);
                        await Utils.sleep(jitter);
                    }
                }

                return parsedAnswers;
            }

            // TYPE 2: Radio or Checkbox
            const inputNodes = questionData.inputs;
            const maxIndex = inputNodes.length - 1;
            const outOfBounds = parsedAnswers.filter(n => n > maxIndex);
            if (outOfBounds.length > 0) {
                throw new Error(
                    `Validation Error: Option index ${outOfBounds.join(', ')} is out of bounds. This question has ${inputNodes.length} options, so valid 0-based indices are 0 to ${maxIndex}.`
                );
            }

            let parsedIndexes = Array.from(new Set(parsedAnswers));
            if (questionData.type === 'radio' && parsedIndexes.length > 1) {
                parsedIndexes = [parsedIndexes[0]];
            }

            Logger.info(`Applying selections: ${JSON.stringify(parsedIndexes)}`);

            if (questionData.type === 'checkbox') {
                // First uncheck any pre-checked boxes that are NOT in parsedIndexes
                for (let idx = 0; idx < inputNodes.length; idx++) {
                    if (inputNodes[idx].checked && !parsedIndexes.includes(idx)) {
                        inputNodes[idx].click();
                        await Utils.sleep(150);
                    }
                }
            }

            for (const index of parsedIndexes) {
                const targetNode = inputNodes[index];
                if (!targetNode) continue;

                if (questionData.type === 'checkbox') {
                    if (!targetNode.checked) targetNode.click();
                } else {
                    targetNode.click();
                }

                if (CONFIG.HIGHLIGHT_GREEN) {
                    const styleWrapper = targetNode.closest('.r0, .r1, .answer > div') || targetNode.parentElement;
                    if (styleWrapper) {
                        styleWrapper.style.transition = 'all 0.4s cubic-bezier(0.165, 0.84, 0.44, 1)';
                        styleWrapper.style.backgroundColor = 'rgba(16, 185, 129, 0.15)';
                        styleWrapper.style.borderLeft = '4px solid #10b981';
                        styleWrapper.style.paddingLeft = '10px';
                    }
                }

                if (parsedIndexes.length > 1) {
                    const jitter = Utils.getRandomDelay(CONFIG.DELAY_BETWEEN_CLICKS_MIN, CONFIG.DELAY_BETWEEN_CLICKS_MAX);
                    await Utils.sleep(jitter);
                }
            }

            return parsedIndexes;
        },

        triggerNavigation: () => {
            const nextButtonNode = document.querySelector('input[name="next"], button[name="next"], .mod_quiz-next-nav');
            if (nextButtonNode) {
                Logger.info("Navigation triggered.");

                // Visual feedback to understand when the script clicks "Next"
                if (CONFIG.HIGHLIGHT_GREEN) {
                    nextButtonNode.style.transition = 'all 0.4s cubic-bezier(0.165, 0.84, 0.44, 1)';
                    nextButtonNode.style.backgroundColor = '#4f46e5'; // Indigo primary
                    nextButtonNode.style.color = '#fff';
                    nextButtonNode.style.transform = 'scale(1.02)';
                    nextButtonNode.style.boxShadow = '0 10px 15px -3px rgba(79, 70, 229, 0.4)';
                    nextButtonNode.style.border = 'none';
                }

                // If on localhost (testing), we prevent navigation to see the feedback
                if (window.location.hostname === 'localhost') {
                    Logger.info("[TEST-MODE] Click simulated. On real Moodle, this would navigate.");
                    return;
                }

                nextButtonNode.click();
            }
        },

        // Checks if we are on the summary page, clicks the initial submit, then handles the modal
        handleAutoSubmitPage: async () => {
            const submitForm = document.querySelector('#frm-finishattempt');
            if (submitForm) {
                if (CONFIG.AUTO_SUBMIT_TEST) {
                    Logger.info("Summary page detected. Auto-submitting the test...");
                    const submitBtn = submitForm.querySelector('button[type="submit"]');

                    if (submitBtn) {
                        await Utils.sleep(Utils.getRandomDelay(CONFIG.DELAY_SUBMIT_INITIAL_MIN, CONFIG.DELAY_SUBMIT_INITIAL_MAX));
                        submitBtn.click();
                        Logger.info("Initial submit button clicked. Waiting for confirmation modal...");

                        let attempts = 0;
                        while (attempts < 10) {
                            await Utils.sleep(CONFIG.DELAY_MODAL_POLL);

                            const confirmBtn = document.querySelector('.modal-footer button[data-action="save"]');

                            if (confirmBtn && confirmBtn.offsetParent !== null) {
                                await Utils.sleep(Utils.getRandomDelay(CONFIG.DELAY_CONFIRM_FINAL_MIN, CONFIG.DELAY_CONFIRM_FINAL_MAX));
                                confirmBtn.click();
                                Logger.info("Modal confirmation button clicked. Test submitted successfully.");
                                break;
                            }
                            attempts++;
                        }
                    }
                } else {
                    Logger.info("Summary page detected. Auto-submit is DISABLED. Waiting for user action.");
                }
                return true; // Indicates we are on the submit page
            }
            return false; // Not the submit page
        }
    };

    const ConfigUI = {
        _injectStyles: () => {
            const css = `
                #ai-config-panel {
                    position: fixed; top: 10px; right: 10px; width: 235px;
                    background: #0f172a; border: 1px solid #334155; border-radius: 0px;
                    color: #fff; font-family: monospace; color-scheme: dark;
                    z-index: 10000; padding: 10px;
                }
                #ai-config-panel.minimized { width: 32px; height: 32px; padding: 0; display: flex; align-items: center; justify-content: center; background: transparent; border: none; }
                #ai-config-panel h3 { margin: 0 0 6px; font-size: 11px; color: #94a3b8; border-bottom: 1px solid #334155; padding-bottom: 4px; text-transform: uppercase; }
                #ai-status-text { font-size: 9px; color: #94a3b8; margin-bottom: 8px; padding: 3px 4px; background: #1e293b; border-left: 2px solid #38bdf8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .config-row { margin-bottom: 6px; display: flex; flex-direction: column; }
                .config-row label { font-size: 9px; color: #64748b; margin-bottom: 2px; }
                .config-row select, .config-row input, .config-row textarea {
                    background: #1e293b; border: 1px solid #334155;
                    border-radius: 0; color: #38bdf8; padding: 3px; font-size: 10px; outline: none; font-family: monospace;
                }
                .config-row textarea { resize: vertical; min-height: 34px; max-height: 90px; }
                .config-row input[type="number"]::-webkit-inner-spin-button {
                    opacity: 1; filter: invert(0.8); cursor: pointer;
                }
                .config-check { flex-direction: row; align-items: center; gap: 6px; }
                .config-check input { width: 12px; height: 12px; margin: 0; }
                #ai-config-stop {
                    width: 100%; border: none; color: white; padding: 5px; cursor: pointer; 
                    font-family: monospace; font-weight: bold; font-size: 11px; margin-top: 5px;
                }
                #ai-config-stop { background: #be123c; }
                #ai-config-stop.paused { background: #15803d; }
                .minimized #ai-config-content { display: none; }
            `;
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
        },

        init: () => {
            ConfigUI._injectStyles();
            Utils.loadConfig();
            IS_PAUSED = GM_Wrapper.getValue(STORAGE_KEYS.PAUSED, false);

            const panel = document.createElement('div');
            panel.id = 'ai-config-panel';
            if (GM_Wrapper.getValue('ai_config_minimized', false)) panel.classList.add('minimized');

            const modelOptions = AVAILABLE_MODELS
                .map(m => `<option value="${m}" ${CONFIG.MODEL === m ? 'selected' : ''}>${m}</option>`)
                .join('');

            const fallbackOptions = AVAILABLE_MODELS
                .map(m => `<option value="${m}" ${CONFIG.FALLBACK_MODEL === m ? 'selected' : ''}>${m}</option>`)
                .join('');

            panel.innerHTML = `
                <div id="ai-gui-toggle" style="cursor:pointer; font-size:14px; margin-bottom: 5px;">${GM_Wrapper.getValue('ai_config_minimized', false) ? '⚙️' : '[HIDE]'}</div>
                <div id="ai-config-content">
                    <h3>SOLVER v1.7.0</h3>
                    <div id="ai-status-text">Idle</div>
                    <div class="config-row">
                        <label>Primary Model</label>
                        <select class="cfg-auto" id="cfg-model">${modelOptions}</select>
                    </div>
                    <div class="config-row">
                        <label>Fallback Model</label>
                        <select class="cfg-auto" id="cfg-fb-model">${fallbackOptions}</select>
                    </div>
                    <div class="config-row">
                        <label>API Keys (1 per line)</label>
                        <textarea class="cfg-auto" id="cfg-keys" rows="2" placeholder="Paste Gemini API keys...">${(CONFIG.API_KEYS || []).join('\n')}</textarea>
                    </div>
                    <div class="config-row">
                        <label>Key Rotation</label>
                        <select class="cfg-auto" id="cfg-key-strategy">
                            <option value="exhaust" ${CONFIG.KEY_STRATEGY === 'exhaust' ? 'selected' : ''}>Exhaust (K1 -> K2)</option>
                            <option value="round_robin" ${CONFIG.KEY_STRATEGY === 'round_robin' ? 'selected' : ''}>Round-Robin (Cycle)</option>
                        </select>
                    </div>
                    <div class="config-row">
                        <label>Extra Context</label>
                        <input class="cfg-auto" type="text" id="cfg-context" value="${CONFIG.EXTRA_CONTEXT || ''}">
                    </div>
                    <div class="config-row">
                        <label>Temperature (0.0 - 2.0)</label>
                        <input class="cfg-auto" type="number" step="0.1" min="0" max="2" id="cfg-temp" value="${CONFIG.TEMPERATURE ?? 0.2}">
                    </div>
                    <div class="config-row config-check">
                        <input class="cfg-auto" type="checkbox" id="cfg-highlight" ${CONFIG.HIGHLIGHT_GREEN ? 'checked' : ''}>
                        <label for="cfg-highlight">Highlight</label>
                    </div>
                    <div class="config-row config-check">
                        <input class="cfg-auto" type="checkbox" id="cfg-autosubmit" ${CONFIG.AUTO_SUBMIT_TEST ? 'checked' : ''}>
                        <label for="cfg-autosubmit">Auto Submit</label>
                    </div>
                    <div class="config-row config-check">
                        <input class="cfg-auto" type="checkbox" id="cfg-forced" ${CONFIG.ENABLE_FORCED_DELAY ? 'checked' : ''}>
                        <label for="cfg-forced">Forced Delay</label>
                    </div>
                    <button id="ai-config-stop" class="${IS_PAUSED ? 'paused' : ''}">${IS_PAUSED ? 'RESUME' : 'STOP'}</button>
                </div>
            `;

            document.body.appendChild(panel);

            document.getElementById('ai-gui-toggle').onclick = () => {
                const isMin = panel.classList.toggle('minimized');
                document.getElementById('ai-gui-toggle').innerText = isMin ? '⚙️' : '[HIDE]';
                GM_Wrapper.setValue('ai_config_minimized', isMin);
            };

            const stopBtn = document.getElementById('ai-config-stop');
            stopBtn.onclick = () => {
                IS_PAUSED = !IS_PAUSED;
                GM_Wrapper.setValue(STORAGE_KEYS.PAUSED, IS_PAUSED);
                stopBtn.innerText = IS_PAUSED ? 'RESUME' : 'STOP';
                stopBtn.classList.toggle('paused', IS_PAUSED);
            };

            panel.querySelectorAll('.cfg-auto').forEach(el => {
                el.addEventListener('change', () => {
                    CONFIG.MODEL = document.getElementById('cfg-model').value;
                    CONFIG.FALLBACK_MODEL = document.getElementById('cfg-fb-model').value;
                    const parsedKeys = Utils.parseKeysInput(document.getElementById('cfg-keys').value);
                    if (parsedKeys.length > 0) {
                        CONFIG.API_KEYS = parsedKeys;
                    }
                    CONFIG.KEY_STRATEGY = document.getElementById('cfg-key-strategy').value;
                    CONFIG.EXTRA_CONTEXT = document.getElementById('cfg-context').value;
                    CONFIG.TEMPERATURE = parseFloat(document.getElementById('cfg-temp').value) || 0.2;
                    CONFIG.HIGHLIGHT_GREEN = document.getElementById('cfg-highlight').checked;
                    CONFIG.AUTO_SUBMIT_TEST = document.getElementById('cfg-autosubmit').checked;
                    CONFIG.ENABLE_FORCED_DELAY = document.getElementById('cfg-forced').checked;
                    Utils.saveConfig();
                    Logger.info("Settings saved automatically.");
                });
            });
        }
    };

    const executeRoutine = async () => {
        ConfigUI.init();
        Logger.info("Core routine engaged. Initializing...");
        const startTime = Date.now(); // Record start time for forced delay calculation

        try {
            // Check if we are on the final summary page
            const isSubmitPage = await UIManipulator.handleAutoSubmitPage();
            if (isSubmitPage) return; // Exit if we handled the submit page

            const initialWait = Utils.getRandomDelay(CONFIG.DELAY_READING_MIN, CONFIG.DELAY_READING_MAX);
            await Utils.sleep(initialWait);

            // CHANGED: Use extractAllQuestions instead of extractQuestionContext
            const allQuestions = PageParser.extractAllQuestions();
            if (allQuestions.length === 0) {
                Logger.warn("No question data found on this page.");
                return;
            }

            Logger.info(`Detected ${allQuestions.length} questions on this page.`);

            // Process each question sequentially
            for (let i = 0; i < allQuestions.length; i++) {
                // Check for pause state
                while (IS_PAUSED) {
                    await Utils.sleep(500);
                }

                const questionData = allQuestions[i];
                Logger.info(`Processing Question ${i + 1}/${allQuestions.length}: (Type: ${questionData.type})`);

                // Give visual focus to the current question block
                if (CONFIG.HIGHLIGHT_GREEN) {
                    questionData.block.style.transition = 'box-shadow 0.6s ease';
                    questionData.block.style.boxShadow = '0 0 0 3px rgba(79, 70, 229, 0.4)';
                    questionData.block.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await Utils.sleep(CONFIG.DELAY_SCROLL_FOCUS);
                }

                const prompt = AIClient._buildPrompt(questionData);
                let lastError = null;
                let lastAiResponse = null;
                let success = false;

                for (let attempt = 1; attempt <= CONFIG.MAX_PARSE_RETRIES + 1; attempt++) {
                    let aiResponse;

                    try {
                        if (attempt === 1) {
                            aiResponse = await AIClient.evaluateQuestion(questionData);
                        } else {
                            Logger.warn(`Parse retry ${attempt - 1}/${CONFIG.MAX_PARSE_RETRIES} (Reason: ${lastError?.message})...`);
                            aiResponse = await AIClient.evaluateQuestionRetry(
                                questionData,
                                prompt,
                                lastAiResponse,
                                lastError?.message || ''
                            );
                        }
                    } catch (apiError) {
                        lastError = apiError;
                        Logger.error(`API failure on Question ${i + 1}: ${apiError.message}`);
                        break; // Do not run parse retries if the API call itself failed after all backoff waves
                    }

                    lastAiResponse = aiResponse;

                    try {
                        const decisionWait = Utils.getRandomDelay(CONFIG.DELAY_DECIDING_MIN, CONFIG.DELAY_DECIDING_MAX);
                        await Utils.sleep(decisionWait);

                        const appliedAnswers = await UIManipulator.applySelection(questionData, aiResponse);
                        Logger.persistHistory(questionData, aiResponse, appliedAnswers);
                        success = true;
                        break;
                    } catch (parseError) {
                        lastError = parseError;
                        Logger.warn(`Attempt ${attempt} validation failed: ${parseError.message}`);
                    }
                }

                if (!success) {
                    Logger.error(`All attempts exhausted for question ${i + 1}.`);
                    Logger.persistError({
                        questionData,
                        errorMessage: lastError?.message || 'Unknown error',
                        model: CONFIG.MODEL,
                        aiRawResponse: lastAiResponse,
                        attempt: CONFIG.MAX_PARSE_RETRIES + 1
                    });

                    if (CONFIG.HIGHLIGHT_GREEN) {
                        questionData.block.style.boxShadow = 'none';
                        questionData.block.style.border = '2px solid #ef4444'; // Red border for failure
                    }
                    continue; // Skip to next question
                }

                if (CONFIG.HIGHLIGHT_GREEN) {
                    questionData.block.style.boxShadow = 'none';
                }

                if (i < allQuestions.length - 1) {
                    await Utils.sleep(Utils.getRandomDelay(CONFIG.DELAY_BETWEEN_QUESTIONS_MIN, CONFIG.DELAY_BETWEEN_QUESTIONS_MAX));
                }
            }

            while (IS_PAUSED) {
                Utils.setStatus('PAUSED', '#eab308');
                await Utils.sleep(500);
            }

            const finalWait = Utils.getRandomDelay(CONFIG.DELAY_NEXT_PAGE_MIN, CONFIG.DELAY_NEXT_PAGE_MAX);
            await Utils.sleep(finalWait);

            // Handle forced delay if enabled
            if (CONFIG.ENABLE_FORCED_DELAY) {
                const targetDelayMs = Utils.getRandomDelay(CONFIG.MIN_PAGE_TIME_SEC, CONFIG.MAX_PAGE_TIME_SEC) * 1000;
                const elapsedTimeMs = Date.now() - startTime;

                if (elapsedTimeMs < targetDelayMs) {
                    const remainingTimeMs = targetDelayMs - elapsedTimeMs;
                    Logger.info(`Forced delay active. Waiting an additional ${(remainingTimeMs / 1000).toFixed(1)} seconds...`);
                    await Utils.sleepWithCountdown(remainingTimeMs, 'Forced Page Delay');
                }
            }

            while (IS_PAUSED) {
                Utils.setStatus('PAUSED', '#eab308');
                await Utils.sleep(500);
            }

            UIManipulator.triggerNavigation();

        } catch (fatalError) {
            Logger.error(`Routine failed: ${fatalError.message}`);
        }
    };

    if (document.readyState === 'complete') {
        executeRoutine();
    } else {
        window.addEventListener('load', executeRoutine);
    }

})();
