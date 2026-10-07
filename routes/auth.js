
const express = require('express');
const router = express.Router();
const { register, login, changePassword } = require('../controllers/authController');
const { verifyToken, isAdmin } = require('../middleware/authMiddleware');

router.post('/register', verifyToken, isAdmin, register);
router.post('/login', login);
router.post('/register-worker', verifyToken, isAdmin, register);
router.post('/change-password', verifyToken, changePassword);

module.exports = router;
