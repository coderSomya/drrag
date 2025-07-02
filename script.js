// Configuration
const CONFIG = {   
    PINECONE_API_KEY: "",
    PINECONE_INDEX_URL: "",
    HUGGINGFACE_TOKEN: "",
};

let selectedFile = null;

// DOM Elements
const fileInput = document.getElementById('fileInput');
const uploadArea = document.querySelector('.upload-area');
const uploadBtn = document.getElementById('uploadBtn');
const uploadStatus = document.getElementById('uploadStatus');
const fileInfo = document.getElementById('fileInfo');
const queryInput = document.getElementById('queryInput');
const queryBtn = document.getElementById('queryBtn');
const queryStatus = document.getElementById('queryStatus');
const queryResults = document.getElementById('queryResults');

// Event Listeners
document.addEventListener('DOMContentLoaded', function() {
    fileInput.addEventListener('change', handleFileSelect);
    uploadArea.addEventListener('dragover', handleDragOver);
    uploadArea.addEventListener('dragleave', handleDragLeave);
    uploadArea.addEventListener('drop', handleDrop);
    uploadBtn.addEventListener('click', processFile);
    queryBtn.addEventListener('click', queryDocuments);
});

// File handling functions
function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file && file.type === 'application/pdf') {
        selectedFile = file;
        showFileInfo(file);
        uploadBtn.disabled = false;
    } else {
        showStatus(uploadStatus, 'Please select a valid PDF file.', 'error');
    }
}

function handleDragOver(e) {
    e.preventDefault();
    uploadArea.classList.add('dragover');
}

function handleDragLeave(e) {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
}

function handleDrop(e) {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type === 'application/pdf') {
        selectedFile = files[0];
        fileInput.files = files;
        showFileInfo(files[0]);
        uploadBtn.disabled = false;
    } else {
        showStatus(uploadStatus, 'Please drop a valid PDF file.', 'error');
    }
}

// UI helper functions
function showFileInfo(file) {
    fileInfo.style.display = 'block';
    fileInfo.innerHTML = `
        <strong>Selected File:</strong> ${file.name}<br>
        <strong>Size:</strong> ${(file.size / 1024 / 1024).toFixed(2)} MB<br>
        <strong>Type:</strong> ${file.type}
    `;
}

function showStatus(element, message, type) {
    element.innerHTML = `<div class="status ${type}">${message}</div>`;
}

function showLoadingStatus(element, message) {
    element.innerHTML = `<div class="status info"><span class="loading"></span>${message}</div>`;
}

// PDF processing functions
async function extractTextFromPDF(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async function(e) {
            try {
                const arrayBuffer = e.target.result;
                const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
                const textChunks = [];
                
                for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                    const page = await pdf.getPage(pageNum);
                    const textContent = await page.getTextContent();
                    
                    // Extract text from the page
                    let pageText = '';
                    textContent.items.forEach(item => {
                        pageText += item.str + ' ';
                    });
                    
                    // Clean up the text
                    pageText = pageText.trim().replace(/\s+/g, ' ');
                    
                    if (pageText.length > 0) {
                        // Split long pages into smaller chunks (roughly 500 characters each)
                        if (pageText.length > 500) {
                            const sentences = pageText.match(/[^\.!?]+[\.!?]+/g) || [pageText];
                            let currentChunk = '';
                            
                            for (const sentence of sentences) {
                                if (currentChunk.length + sentence.length > 500 && currentChunk.length > 0) {
                                    textChunks.push(`[Page ${pageNum}] ${currentChunk.trim()}`);
                                    currentChunk = sentence;
                                } else {
                                    currentChunk += sentence;
                                }
                            }
                            
                            if (currentChunk.trim().length > 0) {
                                textChunks.push(`[Page ${pageNum}] ${currentChunk.trim()}`);
                            }
                        } else {
                            textChunks.push(`[Page ${pageNum}] ${pageText}`);
                        }
                    }
                }
                
                if (textChunks.length === 0) {
                    reject(new Error('No text content found in PDF'));
                } else {
                    resolve(textChunks);
                }
            } catch (error) {
                reject(new Error(`PDF processing failed: ${error.message}`));
            }
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsArrayBuffer(file);
    });
}

// Embedding and storage functions
async function generateEmbeddings(text) {
    const response = await fetch('https://api-inference.huggingface.co/models/intfloat/e5-large-v2', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${CONFIG.HUGGINGFACE_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            inputs: text
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Embedding generation failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const result = await response.json();
    
    // Handle the response format: it's an array of arrays, we want the first array
    if (Array.isArray(result) && result.length > 0 && Array.isArray(result[0])) {
        return result[0]; // Return the embedding vector (array of floats)
    } else {
        throw new Error(`Unexpected embedding response format: ${JSON.stringify(result)}`);
    }
}

async function storeToPinecone(embeddings, texts, filename) {
    const vectors = embeddings.map((embedding, index) => ({
        id: `${filename}_chunk_${index}`,
        values: embedding,
        metadata: {
            text: texts[index],
            filename: filename,
            chunk_index: index
        }
    }));

    const response = await fetch(`${CONFIG.PINECONE_INDEX_URL}/vectors/upsert`, {
        method: 'POST',
        headers: {
            'Api-Key': CONFIG.PINECONE_API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            vectors: vectors,
            namespace: 'pdf-documents'
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Pinecone storage failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return await response.json();
}

// Main processing function
async function processFile() {
    if (!selectedFile) return;

    uploadBtn.disabled = true;
    showLoadingStatus(uploadStatus, 'Processing PDF...');

    try {
        // Extract text from PDF
        showLoadingStatus(uploadStatus, 'Extracting text from PDF...');
        const textChunks = await extractTextFromPDF(selectedFile);

        // Generate embeddings
        showLoadingStatus(uploadStatus, 'Generating embeddings...');
        const embeddings = [];
        for (const chunk of textChunks) {
            const embedding = await generateEmbeddings(chunk);
            embeddings.push(embedding);
            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Store in Pinecone
        showLoadingStatus(uploadStatus, 'Storing embeddings in Pinecone...');
        await storeToPinecone(embeddings, textChunks, selectedFile.name);

        showStatus(uploadStatus, `✅ Successfully processed "${selectedFile.name}" and stored ${embeddings.length} chunks in Pinecone!`, 'success');
    } catch (error) {
        console.error('Processing error:', error);
        showStatus(uploadStatus, `❌ Error processing file: ${error.message}`, 'error');
    } finally {
        uploadBtn.disabled = false;
    }
}

// Query functions
async function queryDocuments() {
    const query = queryInput.value.trim();
    if (!query) {
        showStatus(queryStatus, 'Please enter a query.', 'error');
        return;
    }

    queryBtn.disabled = true;
    showLoadingStatus(queryStatus, 'Searching documents...');
    queryResults.innerHTML = '';

    try {
        // Generate embedding for query
        const queryEmbedding = await generateEmbeddings(query);

        // Search in Pinecone
        const searchResponse = await fetch(`${CONFIG.PINECONE_INDEX_URL}/query`, {
            method: 'POST',
            headers: {
                'Api-Key': CONFIG.PINECONE_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                vector: queryEmbedding,
                topK: 5,
                includeMetadata: true,
                namespace: 'pdf-documents'
            })
        });

        if (!searchResponse.ok) {
            const errorText = await searchResponse.text();
            throw new Error(`Search failed: ${searchResponse.status} ${searchResponse.statusText} - ${errorText}`);
        }

        const searchResults = await searchResponse.json();
        console.log(searchResults)
        displayResults(searchResults.matches, query);
        showStatus(queryStatus, `✅ Found ${searchResults.matches.length} relevant results!`, 'success');

    } catch (error) {
        console.error('Query error:', error);
        showStatus(queryStatus, `❌ Error querying documents: ${error.message}`, 'error');
    } finally {
        queryBtn.disabled = false;
    }
}

function displayResults(matches, query) {
    if (matches.length === 0) {
        queryResults.innerHTML = '<div class="result-item">No relevant documents found.</div>';
        return;
    }

    queryResults.innerHTML = matches.map(match => `
        <div class="result-item">
            <div class="result-score">Relevance Score: ${(match.score * 100).toFixed(1)}%</div>
            <div><strong>Source:</strong> ${match.metadata.filename}</div>
            <div><strong>Content:</strong> ${match.metadata.text}</div>
        </div>
    `).join('');
}
