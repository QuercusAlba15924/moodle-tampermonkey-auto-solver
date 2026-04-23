// ==UserScript==
// @name         Moodle AI Auto-Solver (High-Velocity & Context Aware)
// @namespace    http://tampermonkey.net/
// @version      1.5.5
// @description  Optimized Moodle solver with context awareness, forced delays, and modal auto-submit.
// @author       QuercusAlba15924
// @author       Gemini 3.1 Pro, Gemini 3.0 Flash, Claude 4.6 Opus Thinking
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
        API: 'gemini_api_key'
    };

    const CONFIG = {
        MODEL: 'gemini-3.1-flash-lite-preview',
        FALLBACK_MODEL: 'gemma-4-31b-it',
        EXTRA_CONTEXT: '',

        HIGHLIGHT_GREEN: true,
        RETRY_DELAY_MS: 15000,
        MAX_RETRIES: 3,
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
            `Your response above could NOT be parsed. It did not contain the answer in [text] format.`,
            ``,
            `Look at your own analysis above and extract the answer.`,
            `Respond with ONLY the answer in square brackets. Nothing else.`,
            ``,
            `CORRECT format: [Paris]`,
        ].join('\n'),
    };

    // Polyfills for GM_ functions to allow the script to run in a normal browser tab for testing
    const GM_Wrapper = {
        getValue: (key, defaultValue) => {
            let val;
            if (typeof GM_getValue !== 'undefined') val = GM_getValue(key);
            else val = localStorage.getItem(key);

            if (!val) return defaultValue;
            try {
                return JSON.parse(val);
            } catch (e) {
                return val || defaultValue;
            }
        },
        setValue: (key, value) => {
            const strValue = JSON.stringify(value);
            if (typeof GM_setValue !== 'undefined') GM_setValue(key, strValue);
            else localStorage.setItem(key, strValue);
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

        loadConfig: () => {
            const saved = GM_Wrapper.getValue(STORAGE_KEYS.CONFIG, {});
            for (const key of Object.keys(saved)) {
                if (key in CONFIG) {
                    CONFIG[key] = saved[key];
                }
            }
        },

        saveConfig: () => {
            GM_Wrapper.setValue(STORAGE_KEYS.CONFIG, CONFIG);
        },

        getApiKey: () => {
            let key = GM_Wrapper.getValue(STORAGE_KEYS.API, '');
            if (!key) {
                key = prompt('Moodle AI Solver Initialization:\nPlease provide your Google Gemini API Key:');
                if (key && key.trim()) {
                    GM_Wrapper.setValue(STORAGE_KEYS.API, key.trim());
                } else {
                    throw new Error('Key missing.');
                }
            }
            return key;
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

                const questionText = questionContainer.innerText.trim().replace(/\n/g, ' ');

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
                        const opts = Array.from(selectNode.options)
                            .filter(opt => opt.value !== "0" && opt.value !== "-1" && opt.innerText.trim() !== "" && !opt.innerText.includes("Choose") && !opt.innerText.includes("Select"))
                            .map(opt => opt.innerText.trim());

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


    const AIClient = {
        /**
         * Builds the prompt string from question data.
         */
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

        /**
         * Builds a multi-turn contents array for retry.
         * Turn 1 (user):  original prompt
         * Turn 2 (model): the failed AI response
         * Turn 3 (user):  type-specific correction instruction
         */
        _buildRetryContents: (originalPrompt, failedResponse, questionType) => {
            let retryMessage;
            if (questionType === 'select') retryMessage = PROMPTS.RETRY_MATCHING;
            else if (questionType === 'shortanswer') retryMessage = PROMPTS.RETRY_SHORTANSWER;
            else retryMessage = PROMPTS.RETRY_INDICES;

            return [
                { role: 'user', parts: [{ text: originalPrompt }] },
                { role: 'model', parts: [{ text: failedResponse }] },
                { role: 'user', parts: [{ text: retryMessage }] },
            ];
        },

        /**
         * Sends a request to the Gemini API with the given contents.
         * Returns { ok: true, text } on success, or { ok: false, status } on failure.
         */
        _callModel: async (modelName, contents, apiKey) => {
            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
            const payload = { contents };

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.status === 200) {
                const responseData = await response.json();
                if (!responseData.candidates?.[0]) throw new Error("Empty AI response (safety block or quota)");
                return { ok: true, text: responseData.candidates[0].content.parts[0].text.trim() };
            }

            return { ok: false, status: response.status };
        },

        /**
         * First attempt: single-turn request.
         */
        evaluateQuestion: async (questionData, attempt = 1) => {
            const apiKey = Utils.getApiKey().trim();
            const prompt = AIClient._buildPrompt(questionData);
            const contents = [{ role: 'user', parts: [{ text: prompt }] }];

            return await AIClient._executeWithModelLogic(CONFIG.MODEL, contents, apiKey, questionData, attempt);
        },

        /**
         * Retry attempts: multi-turn request with history.
         */
        evaluateQuestionRetry: async (questionData, originalPrompt, failedResponse, attempt = 1) => {
            const apiKey = Utils.getApiKey().trim();
            const contents = AIClient._buildRetryContents(originalPrompt, failedResponse, questionData.type);

            return await AIClient._executeWithModelLogic(CONFIG.MODEL, contents, apiKey, questionData, attempt);
        },

        /**
         * Handles model switching (503) and rate limits (429).
         */
        _executeWithModelLogic: async (modelName, contents, apiKey, questionData, attempt) => {
            const primaryResult = await AIClient._callModel(modelName, contents, apiKey);
            if (primaryResult.ok) return primaryResult.text;

            // 503 = Model overloaded: try fallback model
            if (primaryResult.status === 503 && CONFIG.FALLBACK_MODEL) {
                Logger.warn(`Model (${modelName}) unavailable (503). Switching to fallback: ${CONFIG.FALLBACK_MODEL}`);
                const fallbackResult = await AIClient._callModel(CONFIG.FALLBACK_MODEL, contents, apiKey);
                if (fallbackResult.ok) return fallbackResult.text;

                throw new Error(`Both models failed. Primary: 503, Fallback (${CONFIG.FALLBACK_MODEL}): ${fallbackResult.status}`);
            }

            // 429 = Rate Limit: retry after cooldown
            if (primaryResult.status === 429 && attempt <= CONFIG.MAX_RETRIES) {
                Logger.warn(`Rate limited (429). Retrying in ${CONFIG.RETRY_DELAY_MS / 1000}s... (Attempt ${attempt}/${CONFIG.MAX_RETRIES})`);
                await Utils.sleep(CONFIG.RETRY_DELAY_MS);
                return await AIClient._executeWithModelLogic(modelName, contents, apiKey, questionData, attempt + 1);
            }

            if (primaryResult.status >= 500) {
                throw new Error(`Server Error ${primaryResult.status}: The API is unavailable.`);
            }

            throw new Error(`Unexpected API Error: HTTP ${primaryResult.status}`);
        }
    };

    const UIManipulator = {
        applySelection: async (questionData, aiResponseText) => {
            if (questionData.type === 'shortanswer') {
                // Find strict FINAL_ANSWER tag
                const matches = aiResponseText.match(/FINAL_ANSWER:\s*\[(.*?)\]/g);
                if (!matches) {
                    Logger.error("Parsing failure. AI output didn't contain FINAL_ANSWER: [x]: " + aiResponseText);
                    throw new Error("Format error: No valid FINAL_ANSWER: [x] found in AI response.");
                }

                const lastMatchText = matches[matches.length - 1];
                const contentMatch = lastMatchText.match(/FINAL_ANSWER:\s*\[(.*)\]/);
                const parsedAnswers = contentMatch ? contentMatch[1].trim() : "";

                Logger.info(`Applying shortanswer text: "${parsedAnswers}"`);

                const targetInput = questionData.inputs[0];
                if (targetInput) {
                    targetInput.value = parsedAnswers;
                    targetInput.dispatchEvent(new Event('input', { bubbles: true }));
                    targetInput.dispatchEvent(new Event('change', { bubbles: true }));

                    if (CONFIG.HIGHLIGHT_GREEN) {
                        targetInput.style.transition = 'all 0.4s cubic-bezier(0.165, 0.84, 0.44, 1)';
                        targetInput.style.backgroundColor = 'rgba(16, 185, 129, 0.15)';
                        targetInput.style.border = '2px solid #10b981';
                    }
                }
                return [parsedAnswers];
            }

            // Find all bracketed index patterns
            const matches = aiResponseText.match(/\[(\d+(?:\s*,\s*\d+)*)\]/g);

            if (!matches) {
                Logger.error("Parsing failure. AI output didn't contain valid indices: " + aiResponseText);
                throw new Error("Format error: No valid indices [x] found in AI response.");
            }

            // Always take the LAST match, as AI usually reasons first and gives answer at the end
            const lastMatchText = matches[matches.length - 1];
            const contentMatch = lastMatchText.match(/\[(.*)\]/);
            const innerContent = contentMatch ? contentMatch[1] : "";

            let parsedAnswers;

            try {
                // Parse the inner content: "0, 2" -> [0, 2]
                parsedAnswers = innerContent.split(',')
                    .map(s => parseInt(s.trim()))
                    .filter(n => !isNaN(n) && n >= 0);

                if (parsedAnswers.length === 0) {
                    throw new Error("Format error: Parsed indices are all invalid (NaN or negative).");
                }

                // Check bounds
                const maxIndex = questionData.inputs.length - 1;
                const outOfBounds = parsedAnswers.filter(n => n > maxIndex);
                if (outOfBounds.length > 0) {
                    Logger.warn(`Indices out of bounds (max ${maxIndex}): ${outOfBounds.join(', ')}. Filtering.`);
                    parsedAnswers = parsedAnswers.filter(n => n <= maxIndex);
                }

                if (parsedAnswers.length === 0) {
                    throw new Error("Format error: All parsed indices were out of bounds.");
                }
            } catch (e) {
                throw new Error("Format error: Failed to parse index array. " + e.message);
            }

            Logger.info(`Applying selections: ${JSON.stringify(parsedAnswers)}`);

            if (questionData.type === 'select') {
                const selectNodes = questionData.inputs;
                for (let i = 0; i < selectNodes.length; i++) {
                    const chosenIndex = parsedAnswers[i];
                    if (chosenIndex !== undefined && chosenIndex !== null) {
                        const targetSelect = selectNodes[i];

                        // Dropdown indices usually include a "Choose..." option at index 0
                        // Our extractAllQuestions filters out "Choose..." so the AI sees clean indices
                        // We need to map the AI's 0-based index to the actual valid option elements
                        const validOptions = Array.from(targetSelect.options).filter(opt =>
                            opt.value !== "0" && opt.value !== "-1" && opt.innerText.trim() !== "" && !opt.innerText.includes("Choose") && !opt.innerText.includes("Select")
                        );

                        const optionToSelect = validOptions[chosenIndex];

                        if (optionToSelect) {
                            targetSelect.value = optionToSelect.value;
                            targetSelect.dispatchEvent(new Event('change', { bubbles: true }));

                            if (CONFIG.HIGHLIGHT_GREEN) {
                                const styleWrapper = targetSelect.closest('.r0, .r1') || targetSelect.parentElement;
                                if (styleWrapper) {
                                    styleWrapper.style.transition = 'all 0.4s cubic-bezier(0.165, 0.84, 0.44, 1)';
                                    styleWrapper.style.backgroundColor = 'rgba(16, 185, 129, 0.15)'; // Sophisticated emerald
                                    styleWrapper.style.borderLeft = '4px solid #10b981';
                                    styleWrapper.style.paddingLeft = '10px';
                                }
                            }
                        } else {
                            Logger.warn(`Option at index ${chosenIndex} not found for dropdown ${i}.`);
                        }

                        if (i < selectNodes.length - 1) {
                            const jitter = Utils.getRandomDelay(CONFIG.DELAY_BETWEEN_CLICKS_MIN, CONFIG.DELAY_BETWEEN_CLICKS_MAX);
                            await Utils.sleep(jitter);
                        }
                    }
                }
                return parsedAnswers;
            } else {
                // Radio or Checkbox logic
                let parsedIndexes = parsedAnswers;
                if (questionData.type === 'radio' && parsedIndexes.length > 1) {
                    parsedIndexes = [parsedIndexes[0]]; // force single choice if AI hallucinates
                }

                const inputNodes = questionData.inputs;
                for (const index of parsedIndexes) {
                    if (index >= 0 && index < inputNodes.length) {
                        const targetNode = inputNodes[index];

                        targetNode.click();

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
                }
                return parsedIndexes;
            }
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
                    position: fixed; top: 10px; right: 10px; width: 220px;
                    background: #0f172a; border: 1px solid #334155; border-radius: 0px;
                    color: #fff; font-family: monospace;
                    z-index: 10000; padding: 10px;
                }
                #ai-config-panel.minimized { width: 32px; height: 32px; padding: 0; display: flex; align-items: center; justify-content: center; background: #334155; }
                #ai-config-panel h3 { margin: 0 0 8px; font-size: 11px; color: #94a3b8; border-bottom: 1px solid #334155; padding-bottom: 4px; text-transform: uppercase; }
                .config-row { margin-bottom: 6px; display: flex; flex-direction: column; }
                .config-row label { font-size: 9px; color: #64748b; margin-bottom: 2px; }
                .config-row select, .config-row input {
                    background: #1e293b; border: 1px solid #334155;
                    border-radius: 0; color: #38bdf8; padding: 3px; font-size: 10px; outline: none;
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

            const panel = document.createElement('div');
            panel.id = 'ai-config-panel';
            if (GM_Wrapper.getValue('ai_config_minimized', false)) panel.classList.add('minimized');

            const modelOptions = [
                'gemini-3.1-flash-lite-preview',
                'gemma-4-31b-it',
                'gemma-3-27b-it'
            ].map(m => `<option value="${m}" ${CONFIG.MODEL === m ? 'selected' : ''}>${m}</option>`).join('');

            const fallbackOptions = [
                'gemma-4-31b-it',
                'gemini-3.1-flash-lite-preview',
                'gemma-3-27b-it'
            ].map(m => `<option value="${m}" ${CONFIG.FALLBACK_MODEL === m ? 'selected' : ''}>${m}</option>`).join('');

            panel.innerHTML = `
                <div id="ai-gui-toggle" style="cursor:pointer; font-size:14px; margin-bottom: 5px;">${GM_Wrapper.getValue('ai_config_minimized', false) ? '⚙️' : '[HIDE]'}</div>
                <div id="ai-config-content">
                    <h3>SOLVER v1.5.5</h3>
                    <div class="config-row">
                        <label>Primary</label>
                        <select class="cfg-auto" id="cfg-model">${modelOptions}</select>
                    </div>
                    <div class="config-row">
                        <label>Fallback</label>
                        <select class="cfg-auto" id="cfg-fb-model">${fallbackOptions}</select>
                    </div>
                    <div class="config-row">
                        <label>Extra Context</label>
                        <input class="cfg-auto" type="text" id="cfg-context" value="${CONFIG.EXTRA_CONTEXT || ''}">
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
                GM_Wrapper.setValue('moodle_ai_is_paused', IS_PAUSED);
                stopBtn.innerText = IS_PAUSED ? 'RESUME' : 'STOP';
                stopBtn.classList.toggle('paused', IS_PAUSED);
            };

            // Auto-save on any change
            panel.querySelectorAll('.cfg-auto').forEach(el => {
                el.addEventListener('change', () => {
                    CONFIG.MODEL = document.getElementById('cfg-model').value;
                    CONFIG.FALLBACK_MODEL = document.getElementById('cfg-fb-model').value;
                    CONFIG.EXTRA_CONTEXT = document.getElementById('cfg-context').value;
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

                    if (attempt === 1) {
                        aiResponse = await AIClient.evaluateQuestion(questionData);
                    } else {
                        Logger.warn(`Parse retry ${attempt - 1}/${CONFIG.MAX_PARSE_RETRIES}...`);
                        aiResponse = await AIClient.evaluateQuestionRetry(questionData, prompt, lastAiResponse);
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
                        Logger.warn(`Attempt ${attempt} failed: ${parseError.message}`);
                    }
                }

                if (!success) {
                    Logger.error(`All parse attempts exhausted for question ${i + 1}.`);
                    Logger.persistError({
                        questionData,
                        errorMessage: lastError.message,
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

            const finalWait = Utils.getRandomDelay(CONFIG.DELAY_NEXT_PAGE_MIN, CONFIG.DELAY_NEXT_PAGE_MAX);
            await Utils.sleep(finalWait);

            // Handle forced delay if enabled
            if (CONFIG.ENABLE_FORCED_DELAY) {
                const targetDelayMs = Utils.getRandomDelay(CONFIG.MIN_PAGE_TIME_SEC, CONFIG.MAX_PAGE_TIME_SEC) * 1000;
                const elapsedTimeMs = Date.now() - startTime;

                if (elapsedTimeMs < targetDelayMs) {
                    const remainingTimeMs = targetDelayMs - elapsedTimeMs;
                    Logger.info(`Forced delay active. Waiting an additional ${(remainingTimeMs / 1000).toFixed(1)} seconds...`);
                    await Utils.sleep(remainingTimeMs);
                }
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
