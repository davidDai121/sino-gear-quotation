const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 8081;

// Configure storage for multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Ensure directory exists
        const dir = 'public/assets/';
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        // IMPORTANT: We need access to req.query here.
        // req.query is available because multer is called as middleware on the request.
        if (req.query.filename) {
            cb(null, req.query.filename);
        } else {
            cb(null, Date.now() + '-' + file.originalname);
        }
    }
});

const upload = multer({ storage: storage });

// Serve static files from public directory
app.use(express.static('public'));

// Upload endpoint
app.post('/upload', (req, res) => {
    // Multer middleware needs to run inside the route handler to catch errors
    // and access query params properly? No, it works as middleware.
    // Let's use upload.single('image') as middleware.
    
    const uploader = upload.single('image');
    uploader(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            return res.status(500).json(err);
        } else if (err) {
            return res.status(500).json(err);
        }
        
        if (!req.file) {
            return res.status(400).send('No file uploaded.');
        }
        console.log(`File uploaded: ${req.file.filename}`);
        res.json({ success: true, filename: req.file.filename });
    });
});

// Proxy endpoint for remote images
app.get('/proxy-image', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send('URL required');

    try {
        const response = await axios({
            url: imageUrl,
            method: 'GET',
            responseType: 'stream',
            headers: {
                // Fake headers to bypass hotlink protection
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': new URL(imageUrl).origin
            }
        });
        
        res.set('Content-Type', response.headers['content-type']);
        response.data.pipe(res);
    } catch (error) {
        console.error('Proxy error:', error.message);
        res.status(500).send('Error fetching image');
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log('Use Ctrl+C to stop.');
});
