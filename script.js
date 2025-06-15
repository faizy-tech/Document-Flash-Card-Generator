"use strict";

// DOM Elements
const fileInput = document.getElementById('file-input');
const generateBtn = document.getElementById('generate-btn');
const uploadStatus = document.getElementById('upload-status');
const flashcardSection = document.getElementById('flashcard-section');
const flashcardElement = document.getElementById('flashcard');
const flashcardQuestion = document.getElementById('flashcard-question');
const flashcardAnswer = document.getElementById('flashcard-answer');
const prevCardBtn = document.getElementById('prev-card-btn');
const nextCardBtn = document.getElementById('next-card-btn');
const cardCounter = document.getElementById('card-counter');
const settingsBtn = document.getElementById('settings-btn');
const settingsPopover = document.getElementById('settings-popover');
const apiKeyInput = document.getElementById('api-key-input');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const historyList = document.getElementById('history-list');

// State
let flashcards = []; // Array to hold generated flashcards { question: '...', answer: '...' }
let currentCardIndex = 0;
let apiKey = localStorage.getItem('geminiApiKey') || '';
let isGenerating = false;
let currentHistoryId = null;
let history = [];
let chatHistory = []; // To maintain conversation context with Gemini
const CARDS_PER_BATCH = 5;
const MAX_CARDS = 35;

// Constants for Gemini API
const GEMINI_MODEL = "gemini-2.0-flash-lite";
const SYSTEM_INSTRUCTION = `You are a flashcard generator. Create unique and educational flashcards based on the uploaded document. Output ONLY JSON objects, one per line, each containing a "question" and an "answer" key. Example:\n{"question": "Q1?", "answer": "A1"}\n{"question": "Q2?", "answer": "A2"}\nDo not include any other text, explanations, markdown formatting, or JSON array brackets. Ensure questions are unique and different from previous ones in the chat history.`;

// --- Initialization ---
function initialize() {
    if (apiKey) {
        apiKeyInput.value = apiKey;
        console.log("API Key loaded from localStorage.");
    } else {
        console.log("No API Key found in localStorage. Please set one in Settings.");
    }
    
    loadHistory();
    addEventListeners();
}

// --- Event Listeners ---
function addEventListeners() {
    generateBtn.addEventListener('click', handleGenerateClick);
    flashcardElement.addEventListener('click', flipCard);
    prevCardBtn.addEventListener('click', showPreviousCard);
    nextCardBtn.addEventListener('click', showNextCard);
    settingsBtn.addEventListener('click', toggleSettingsPopover);
    closeSettingsBtn.addEventListener('click', toggleSettingsPopover);
    saveSettingsBtn.addEventListener('click', saveSettings);
    fileInput.addEventListener('change', handleFileSelect);
    historyList.addEventListener('click', handleHistoryClick);
}

// --- File Handling ---
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        uploadStatus.textContent = `Selected file: ${file.name}`;
        // Reset previous generation state if a new file is selected
        flashcards = [];
        currentCardIndex = 0;
        currentHistoryId = null;
        chatHistory = []; // Reset chat history with new file
        flashcardSection.style.display = 'none';
        updateCardDisplay();
        updateControls();
    } else {
        uploadStatus.textContent = '';
    }
}

async function handleGenerateClick() {
    if (isGenerating) {
        console.log("Already generating...");
        return;
    }

    const file = fileInput.files[0];
    if (!file) {
        uploadStatus.textContent = 'Please select a file first.';
        return;
    }
    if (!apiKey) {
        uploadStatus.textContent = 'Please set your Gemini API Key in Settings.';
        settingsPopover.style.display = 'block';
        return;
    }

    isGenerating = true;
    generateBtn.disabled = true;
    uploadStatus.textContent = 'Processing file and generating flashcards...';
    flashcardSection.style.display = 'none';

    try {
        // Read file as base64
        const fileData = await readFileAsBase64(file);
        if (!fileData) {
            throw new Error("Could not read file.");
        }

        // Determine MIME type based on file extension
        const mimeType = getMimeType(file.name);
        console.log(`File read as ${mimeType}, generating flashcards...`);

        // Reset flashcards and chat history for new generation
        if (currentHistoryId === null) {
            flashcards = [];
            chatHistory = []; // Only reset if not continuing from history
        }
        
        currentCardIndex = 0;
        
        // Generate initial batch of flashcards
        await generateFlashcards(file.name, fileData, mimeType, CARDS_PER_BATCH);

        if (flashcards.length > 0) {
            flashcardSection.style.display = 'block';
            currentCardIndex = 0;
            updateCardDisplay();
            
            // Save to history if this is a new generation (not loaded from history)
            if (currentHistoryId === null) {
                saveHistoryItem(file.name, flashcards);
            }
        } else {
            uploadStatus.textContent = 'Could not generate flashcards from the document.';
        }

    } catch (error) {
        console.error("Error during generation:", error);
        uploadStatus.textContent = `Error: ${error.message}`;
        flashcardSection.style.display = 'none';
    } finally {
        isGenerating = false;
        generateBtn.disabled = false;
        updateControls();
    }
}

// Read file as base64 for inlineData
function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            // Get base64 string without the prefix (e.g., "data:application/pdf;base64,")
            const base64String = event.target.result.split(',')[1];
            resolve(base64String);
        };
        reader.onerror = (error) => {
            console.error("Error reading file:", error);
            reject(error);
        };
        reader.readAsDataURL(file);
    });
}

// Determine MIME type based on file extension
function getMimeType(filename) {
    const extension = filename.split('.').pop().toLowerCase();
    const mimeTypes = {
        'pdf': 'application/pdf',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    };
    return mimeTypes[extension] || 'application/octet-stream';
}

// --- Gemini API Integration (Streaming) ---
async function generateFlashcards(filename, fileData, mimeType, count) {
    if (!apiKey) throw new Error("API Key not set.");
    if (flashcards.length >= MAX_CARDS) return;

    const requestedCount = Math.min(count, MAX_CARDS - flashcards.length);
    if (requestedCount <= 0) return;

    uploadStatus.textContent = `Generating ${requestedCount} flashcards... (Streaming)`;

    // Use the streaming endpoint (generateContent with alt=sse)
    const endpoint = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:streamGenerateContent?key=${encodeURIComponent(apiKey)}&alt=sse`;

    // Add user message with file (only if it's the first call for this file)
    // Subsequent calls only need the request for more cards
    let currentUserMessage;
    if (chatHistory.length <= 1) { // Assuming chatHistory[0] is system instruction
        currentUserMessage = {
            role: "user",
            parts: [
                { text: `Generate ${requestedCount} flashcards from this document. Output ONLY JSON objects, one per line, like {"question": "Q", "answer": "A"}. Do not repeat questions.` },
                { inlineData: { mimeType: mimeType, data: fileData } }
            ]
        };
    } else {
        currentUserMessage = {
            role: "user",
            parts: [
                { text: `Generate ${requestedCount} more unique flashcards based on the document provided earlier. Output ONLY JSON objects, one per line, like {"question": "Q", "answer": "A"}. Do not repeat questions.` }
            ]
        };
    }

    // Add user message to chat history before sending
    chatHistory.push(currentUserMessage);

    // Prepare the request body
    const body = {
        contents: chatHistory,
        generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2048, // Max tokens for the whole stream
            // responseMimeType: "application/json", // Not used for streaming text
        },
        safetySettings: [
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }
        ]
    };

    let accumulatedResponseText = ""; // To build the full model response for history
    let cardsGeneratedInThisStream = 0;

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            // Attempt to read error response, might not be SSE
            const errorText = await response.text();
            let errorMessage = `API Error: ${response.status} ${response.statusText}`;
            try {
                const errorJson = JSON.parse(errorText);
                errorMessage += `. ${errorJson.error?.message || 'Unknown error'}`;
            } catch (e) { /* Ignore parsing error */ }
            console.error("API Error Response Text:", errorText);
            throw new Error(errorMessage);
        }

        if (!response.body) {
            throw new Error("Response body is null");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentLine = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                console.log("Stream finished.");
                break;
            }

            buffer += decoder.decode(value, { stream: true });

            // Process Server-Sent Events data
            const lines = buffer.split('\n');
            buffer = lines.pop() || ""; // Keep incomplete line

            for (const line of lines) {
                if (line.startsWith('data:')) {
                    const dataContent = line.substring(5).trim();
                    try {
                        const parsedData = JSON.parse(dataContent);
                        if (parsedData.candidates && parsedData.candidates[0].content && parsedData.candidates[0].content.parts) {
                            const textPart = parsedData.candidates[0].content.parts[0].text;
                            if (textPart) {
                                accumulatedResponseText += textPart;
                                // Process text part for potential JSON lines
                                currentLine += textPart;
                                const jsonLines = currentLine.split('\n');
                                currentLine = jsonLines.pop() || ""; // Keep incomplete JSON line

                                for (const jsonLine of jsonLines) {
                                    if (jsonLine.trim()) {
                                        try {
                                            const card = JSON.parse(jsonLine.trim());
                                            if (card && typeof card.question === 'string' && typeof card.answer === 'string' && flashcards.length < MAX_CARDS) {
                                                flashcards.push(card);
                                                cardsGeneratedInThisStream++;
                                                console.log(`Card received: ${flashcards.length}`);
                                                // Update UI immediately
                                                updateCardDisplay(); // Update content
                                                updateCardCounter(); // Update counter
                                                updateControls(); // Update buttons
                                                // Update history in localStorage incrementally or at the end
                                                if (currentHistoryId !== null) {
                                                    updateHistoryItem(currentHistoryId, flashcards);
                                                }
                                            }
                                        } catch (e) {
                                            console.warn("Could not parse line as JSON card:", jsonLine.trim(), e);
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.error("Error parsing SSE data chunk:", dataContent, e);
                    }
                }
            }
             if (flashcards.length >= MAX_CARDS) {
                 console.log("Max card limit reached during stream.");
                 // Optionally close the stream early if possible/needed
                 break;
             }
        }

        // Process any remaining buffer (likely empty for SSE)
        if (currentLine.trim()) {
             try {
                 const card = JSON.parse(currentLine.trim());
                 if (card && typeof card.question === 'string' && typeof card.answer === 'string' && flashcards.length < MAX_CARDS) {
                     flashcards.push(card);
                     cardsGeneratedInThisStream++;
                     console.log(`Card received (final): ${flashcards.length}`);
                     updateCardDisplay();
                     updateCardCounter();
                     updateControls();
                     if (currentHistoryId !== null) {
                         updateHistoryItem(currentHistoryId, flashcards);
                     }
                 }
             } catch (e) {
                 console.warn("Could not parse final line as JSON card:", currentLine.trim(), e);
             }
        }

        // Add the accumulated model response to chat history *after* the stream is done
        if (accumulatedResponseText) {
            chatHistory.push({ role: "model", parts: [{ text: accumulatedResponseText }] });
        }

        if (cardsGeneratedInThisStream === 0 && flashcards.length === 0) {
             uploadStatus.textContent = 'API generated no valid flashcards from the text.';
        } else {
             uploadStatus.textContent = `Generated ${flashcards.length} flashcards.`;
        }

    } catch (error) {
        console.error("Streaming API Call failed:", error);
        uploadStatus.textContent = `Streaming Error: ${error.message}`;
        // Remove the user message we optimistically added if the call failed
        if (chatHistory[chatHistory.length - 1] === currentUserMessage) {
            chatHistory.pop();
        }
    }
}

// --- Flashcard Display and Navigation ---
function updateCardDisplay() {
    if (flashcards.length === 0) {
        flashcardQuestion.textContent = 'No flashcards generated or loaded.';
        flashcardAnswer.textContent = '';
        flashcardSection.style.display = 'none';
    } else {
        flashcardSection.style.display = 'block';
        currentCardIndex = Math.max(0, Math.min(currentCardIndex, flashcards.length - 1));
        const card = flashcards[currentCardIndex];
        
        flashcardQuestion.textContent = card.question;
        flashcardAnswer.textContent = card.answer;
        flashcardElement.classList.remove('is-flipped');
    }
    updateControls();
    updateCardCounter();
}

function flipCard() {
    if (flashcards.length > 0) {
        flashcardElement.classList.toggle('is-flipped');
    }
}

function showNextCard() {
    if (currentCardIndex < flashcards.length - 1) {
        currentCardIndex++;
        updateCardDisplay();

        // Generate more cards when approaching the end
        // Check if we need file data (only needed for the *first* call in a session)
        if (flashcards.length < MAX_CARDS && currentCardIndex >= flashcards.length - 2 && !isGenerating) {
            isGenerating = true;
            generateBtn.disabled = true;

            // Subsequent calls don't need file data, rely on chat history
            generateFlashcards(null, null, null, CARDS_PER_BATCH) // Pass nulls for file info
                .catch(err => {
                    uploadStatus.textContent = `Error generating next batch: ${err.message}`;
                })
                .finally(() => {
                    isGenerating = false;
                    generateBtn.disabled = false;
                    updateControls();
                });
        }
    }
}

function showPreviousCard() {
    if (currentCardIndex > 0) {
        currentCardIndex--;
        updateCardDisplay();
    }
}

function updateControls() {
    prevCardBtn.disabled = currentCardIndex === 0;
    nextCardBtn.disabled = currentCardIndex >= flashcards.length - 1 || flashcards.length === 0;
    generateBtn.disabled = isGenerating || !fileInput.files[0];
}

function updateCardCounter() {
    cardCounter.textContent = flashcards.length > 0 ? 
        `${currentCardIndex + 1} / ${flashcards.length}` : '0 / 0';
    
    if (flashcards.length >= MAX_CARDS) {
        cardCounter.textContent += ' (Max)';
    }
}

// --- Settings ---
function toggleSettingsPopover() {
    const isDisplayed = settingsPopover.style.display === 'block';
    settingsPopover.style.display = isDisplayed ? 'none' : 'block';
    if (!isDisplayed) {
        apiKeyInput.value = apiKey;
    }
}

function saveSettings() {
    apiKey = apiKeyInput.value.trim();
    if (apiKey) {
        localStorage.setItem('geminiApiKey', apiKey);
        console.log("API Key saved to localStorage.");
        uploadStatus.textContent = 'API Key saved.';
    } else {
        localStorage.removeItem('geminiApiKey');
        console.log("API Key removed from localStorage.");
        uploadStatus.textContent = 'API Key removed.';
    }
    
    setTimeout(() => { 
        if (uploadStatus.textContent.includes('API Key')) 
            uploadStatus.textContent = ''; 
    }, 3000);
    
    toggleSettingsPopover();
}

// --- History Management --- 
function loadHistory() {
    try {
        const storedHistory = localStorage.getItem('flashcardHistory');
        history = storedHistory ? JSON.parse(storedHistory) : [];
        
        if (!Array.isArray(history)) {
            console.error("History in localStorage is not an array. Resetting.");
            history = [];
            localStorage.removeItem('flashcardHistory');
        }
    } catch (e) {
        console.error("Failed to parse history from localStorage:", e);
        history = [];
        localStorage.removeItem('flashcardHistory');
    }
    
    displayHistory();
}

function saveHistoryItem(filename, cards) {
    if (!filename || !cards || cards.length === 0) return;
    
    const timestamp = Date.now();
    const historyItem = {
        id: timestamp,
        filename: filename,
        date: new Date().toLocaleDateString(),
        time: new Date().toLocaleTimeString(),
        cardCount: cards.length,
        cards: [...cards] // Clone the array to avoid reference issues
    };
    
    // Add to the beginning
    history.unshift(historyItem);
    
    // Limit history to 10 items
    if (history.length > 10) {
        history = history.slice(0, 10);
    }
    
    // Save to localStorage
    try {
        localStorage.setItem('flashcardHistory', JSON.stringify(history));
    } catch (e) {
        console.error("Failed to save history to localStorage:", e);
        alert("Could not save to history due to storage limits. Try clearing old items.");
    }
    
    currentHistoryId = timestamp;
    displayHistory();
}

function updateHistoryItem(historyId, updatedCards) {
    if (!historyId || !updatedCards) return;
    
    const itemIndex = history.findIndex(item => item.id === historyId);
    if (itemIndex === -1) return;
    
    history[itemIndex].cards = [...updatedCards];
    history[itemIndex].cardCount = updatedCards.length;
    
    try {
        localStorage.setItem('flashcardHistory', JSON.stringify(history));
    } catch (e) {
        console.error("Failed to update history in localStorage:", e);
    }
    
    displayHistory();
}

function displayHistory() {
    historyList.innerHTML = '';
    
    if (history.length === 0) {
        const emptyItem = document.createElement('li');
        emptyItem.className = 'history-empty';
        emptyItem.textContent = 'No history yet';
        historyList.appendChild(emptyItem);
        return;
    }
    
    history.forEach(item => {
        const li = document.createElement('li');
        li.className = 'history-item';
        if (item.id === currentHistoryId) {
            li.classList.add('active');
        }
        
        li.dataset.historyId = item.id;
        li.innerHTML = `
            <div class="history-title">${item.filename}</div>
            <div class="history-details">
                ${item.cardCount} cards · ${item.date}
            </div>
        `;
        
        historyList.appendChild(li);
    });
}

function handleHistoryClick(event) {
    if (isGenerating) return;
    
    // Find the li element that was clicked (or its parent if a child was clicked)
    let target = event.target;
    while (target && target.tagName !== 'LI') {
        if (target === historyList) return; // Clicked on empty space
        target = target.parentElement;
    }
    
    if (!target || !target.dataset.historyId) return;
    
    const historyId = parseInt(target.dataset.historyId, 10);
    const selectedItem = history.find(item => item.id === historyId);
    
    if (selectedItem && selectedItem.cards) {
        // Load the flashcards from history
        flashcards = [...selectedItem.cards];
        currentCardIndex = 0;
        currentHistoryId = historyId;
        chatHistory = []; // Reset chat history when loading from saved history
        
        // Update UI
        uploadStatus.textContent = `Loaded ${selectedItem.cardCount} cards from "${selectedItem.filename}"`;
        flashcardSection.style.display = flashcards.length > 0 ? 'block' : 'none';
        fileInput.value = ''; // Clear file input
        
        updateCardDisplay();
        displayHistory(); // Refresh history list to show active item
    }
}

// Apply CSS to history items
function applyHistoryStyles() {
    const style = document.createElement('style');
    style.textContent = `
        #history-list {
            padding: 8px 0;
        }
        
        .history-item {
            padding: 12px;
            margin: 8px 0;
            border-radius: 8px;
            cursor: pointer;
            transition: background-color 0.2s;
            border: 1px solid var(--dusk-border);
        }
        
        .history-item:hover {
            background: rgba(127, 92, 255, 0.1);
        }
        
        .history-item.active {
            background: rgba(0, 255, 231, 0.1);
            border-color: var(--dusk-accent);
        }
        
        .history-title {
            font-weight: 500;
            color: var(--dusk-accent);
            margin-bottom: 4px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        .history-details {
            font-size: 0.8rem;
            color: var(--dusk-muted);
        }
        
        .history-empty {
            text-align: center;
            color: var(--dusk-muted);
            font-style: italic;
            padding: 20px 0;
        }
    `;
    document.head.appendChild(style);
}

// --- Keyboard Controls ---
document.addEventListener('keydown', e => {
  if (settingsPopover.style.display === 'block') return;
  if (e.key === 'ArrowRight' || e.key === 'd') showNextCard();
  if (e.key === 'ArrowLeft' || e.key === 'a') showPreviousCard();
  if (e.key === ' ' || e.key === 'Enter') flipCard();
});

// --- Swipe Animations & Carousel ---
let startX = null;
flashcardElement.addEventListener('touchstart', e => {
  if (e.touches.length === 1) startX = e.touches[0].clientX;
});
flashcardElement.addEventListener('touchend', e => {
  if (startX === null) return;
  let dx = e.changedTouches[0].clientX - startX;
  if (dx > 60) showPreviousCard();
  else if (dx < -60) showNextCard();
  startX = null;
});

// Animate card slide
function animateCard(direction) {
  flashcardElement.classList.remove('slide-left', 'slide-right');
  void flashcardElement.offsetWidth;
  flashcardElement.classList.add(direction === 'left' ? 'slide-left' : 'slide-right');
  setTimeout(() => flashcardElement.classList.remove('slide-left', 'slide-right'), 400);
}

const origShowNext = showNextCard;
showNextCard = function() {
  animateCard('left');
  setTimeout(origShowNext, 120);
};
const origShowPrev = showPreviousCard;
showPreviousCard = function() {
  animateCard('right');
  setTimeout(origShowPrev, 120);
};

// --- Initialize ---
initialize();
applyHistoryStyles();
