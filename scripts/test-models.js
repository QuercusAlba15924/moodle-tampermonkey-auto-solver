/**
 * @fileoverview Utility script to query the Google Generative Language API
 * and retrieve a list of available models. It filters the models to show
 * only those relevant to the Moodle AI Solver project (e.g., Gemini Flash and Gemma).
 */

require('dotenv').config();

/**
 * Executes the model discovery process.
 * Fetches available models from the Google API, categorizes them, 
 * and outputs the result to the console in a structured format.
 */
async function discoverModels() {
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
        console.error("Error: GEMINI_API_KEY is not defined in the environment or .env file.");
        process.exit(1);
    }

    console.log("Initializing model discovery via Google Generative Language API...\n");
    
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

    try {
        const response = await fetch(endpoint);
        
        if (!response.ok) {
            console.error(`HTTP Request Failed: Status ${response.status} - ${response.statusText}`);
            process.exit(1);
        }

        const data = await response.json();
        const models = data.models || [];

        console.log(`Successfully retrieved ${models.length} models.\n`);
        
        // Categorize models for better readability
        const geminiFlashLiteModels = models.filter(m => m.name.toLowerCase().includes('flash-lite'));
        const geminiFlashModels = models.filter(m => m.name.toLowerCase().includes('flash') && !m.name.toLowerCase().includes('flash-lite'));
        const gemmaModels = models.filter(m => m.name.toLowerCase().includes('gemma'));
        
        console.log("CATEGORY: Gemini Flash Lite Models");
        console.log("==================================");
        if (geminiFlashLiteModels.length > 0) {
            geminiFlashLiteModels.forEach(m => console.log(` * ${m.name.replace('models/', '')}`));
        } else {
            console.log(" * No models found in this category.");
        }
        
        console.log("\nCATEGORY: Gemini Flash Models");
        console.log("=============================");
        if (geminiFlashModels.length > 0) {
            geminiFlashModels.forEach(m => console.log(` * ${m.name.replace('models/', '')}`));
        } else {
            console.log(" * No models found in this category.");
        }

        console.log("\nCATEGORY: Gemma Models");
        console.log("======================");
        if (gemmaModels.length > 0) {
            gemmaModels.forEach(m => console.log(` * ${m.name.replace('models/', '')}`));
        } else {
            console.log(" * No models found in this category.");
        }
        
        console.log("\nAction Required: Update the CONFIG object in 'src/moodle-ai-solver.user.js' with the desired model names.");

    } catch (error) {
        console.error("Fatal Error: Request to Google API failed.", error);
        process.exit(1);
    }
}

discoverModels();
