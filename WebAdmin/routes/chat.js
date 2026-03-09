const express = require('express');
const router = express.Router();
const path = require('path');

// Serve chat page at /chat and /chat/
router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/chat/index.html'));
});

module.exports = router;
