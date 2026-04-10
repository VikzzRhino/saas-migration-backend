// auth.controller.js
import bcrypt from 'bcrypt';
import { z } from 'zod';
import * as authService from './auth.service.js';
import User from './user.model.js';
import { sendOtpEmail } from './mail.service.js';
import Otp from './otp.model.js';

const signupSchema = z
  .object({
    fullName: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

const verifyEmailSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const forgotSchema = z.object({ email: z.string().email() });

const resetSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
  newPassword: z.string().min(8),
});

export async function signup(req, res) {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const { email } = await authService.signup(parsed.data);
    res.status(201).json({ message: 'OTP sent to your email', email });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
}

export async function verifyEmail(req, res) {
  const parsed = verifyEmailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const { token, user, apiKey } = await authService.verifyEmail(parsed.data);
    res.cookie('access_token', token, authService.cookieOptions());
    res.json({ message: 'Email verified successfully', user, apiKey });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
}

export async function login(req, res) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const { token, user, apiKey } = await authService.login(parsed.data);
    res.cookie('access_token', token, authService.cookieOptions());
    res.json({ message: 'Logged in successfully', user, apiKey });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
}

export async function logout(req, res) {
  res.clearCookie('access_token');
  res.json({ message: 'Logged out successfully' });
}

export async function session(req, res) {
  res.json({ user: req.user });
}

export async function getApiKey(req, res) {
  res.json({ apiKey: req.tenant?.apiKey ?? null });
}

export async function forgotPassword(req, res) {
  const parsed = forgotSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    await authService.forgotPassword(parsed.data.email);
    res.json({ message: 'OTP sent to your email' });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
}

export async function resetPassword(req, res) {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    await authService.resetPassword(parsed.data);
    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
}

export async function updateProfile(req, res) {
  const { firstName, lastName, email } = req.body;
  if (!firstName && !lastName && !email) {
    return res.status(400).json({ error: 'At least one field is required' });
  }

  try {
    const user = await User.findById(req.user._id ?? req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (email && email !== user.email) {
      const taken = await User.findOne({ email, _id: { $ne: user._id } });
      if (taken) return res.status(409).json({ error: 'Email already in use' });

      user.isVerified = false;

      const otp =
        process.env.NODE_ENV === 'production'
          ? String(Math.floor(100000 + Math.random() * 900000))
          : '123456';
      const otpHash = await bcrypt.hash(otp, 10);
      await Otp.findOneAndReplace(
        { email },
        { email, otpHash, expiresAt: new Date(Date.now() + 5 * 60 * 1000), attempts: 1 },
        { upsert: true, returnDocument: 'after' }
      );
      if (process.env.NODE_ENV === 'production') await sendOtpEmail(email, otp);

      user.email = email;
    }

    if (firstName !== undefined) user.firstName = firstName;
    if (lastName !== undefined) user.lastName = lastName;

    await user.save();

    res.json({
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        isVerified: user.isVerified,
        createdAt: user.createdAt,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }

  try {
    const user = await User.findById(req.user._id ?? req.user.id).select('+password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(400).json({ error: 'Current password is incorrect' });

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    const same = await bcrypt.compare(newPassword, user.password);
    if (same) {
      return res.status(400).json({ error: 'New password must differ from current password' });
    }

    user.password = newPassword;
    await user.save();

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
