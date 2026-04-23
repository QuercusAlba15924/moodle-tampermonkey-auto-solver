const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.txt': 'text/plain'
};

const server = http.createServer((req, res) => {
    console.log(`[REQ] ${req.method} ${req.url}`);

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost:3000'}`);
    let urlPath = parsedUrl.pathname;
    let filePath = '.' + urlPath;

    // Fix: Redirect all style.css requests to the correct location
    if (urlPath.endsWith('style.css')) {
        filePath = './tests/style.css';
    } else if (urlPath === '/' || urlPath === '') {
        filePath = './tests/index.html';
    } else if (urlPath.endsWith('/mod/quiz/attempt.php')) {
        const mockParam = parsedUrl.searchParams.get('mock');
        if (mockParam === 'matching') {
            filePath = './tests/mocks/quiz-page-matching.html';
        } else if (mockParam === 'single') {
            filePath = './tests/mocks/quiz-page-single-answer.html';
        } else if (mockParam === 'multiple') {
            filePath = './tests/mocks/quiz-page-multiple-answer.html';
        } else if (mockParam === 'multi-block') {
            filePath = './tests/mocks/quiz-page-multi-block.html';
        } else if (mockParam === 'shortanswer') {
            filePath = './tests/mocks/quiz-page-shortanswer.html';
        } else if (mockParam === 'before') {
            filePath = './tests/mocks/before-safe-window.html';
        } else {
            filePath = './tests/index.html';
        }
    }

    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = MIME_TYPES[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code == 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 Not Found</h1>', 'utf-8');
            } else {
                res.writeHead(500);
                res.end('Sorry, check with the site admin for error: ' + error.code + ' ..\n');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log(`Open http://localhost:${PORT}/tests/index.html to view tests.`);
});
