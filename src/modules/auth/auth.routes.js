// auth.routes.js
import { Router } from 'express';
import {
  signup,
  verifyEmail,
  login,
  logout,
  session,
  forgotPassword,
  resetPassword,
  updateProfile,
  changePassword,
} from './auth.controller.js';
import { protect } from './auth.middleware.js';

const router = Router();

router.post('/signup', signup);
router.post('/verify-email', verifyEmail);
router.post('/login', login);
router.post('/logout', logout);
router.get('/session', protect, session);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.put('/profile', protect, updateProfile);
router.put('/password', protect, changePassword);

export default router;
