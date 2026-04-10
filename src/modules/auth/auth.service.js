import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import User from './user.model.js';
import Otp from './otp.model.js';
import Tenant from '../tenants/tenant.model.js';
import { sendOtpEmail } from './mail.service.js';

const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const OTP_MAX_ATTEMPTS = 5;

export function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

export function cookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    // Cross-origin frontend (e.g. localhost) needs SameSite=None in production.
    sameSite: isProd ? 'none' : 'lax',
    maxAge: COOKIE_MAX_AGE,
  };
}

export async function signup({ fullName, email, password }) {
  const exists = await User.findOne({ email });
  if (exists) throw { status: 409, message: 'Email already in use' };

  await User.create({ fullName, email, password, isVerified: false });

  const otp =
    process.env.NODE_ENV === 'production'
      ? String(Math.floor(100000 + Math.random() * 900000))
      : '123456';
  const otpHash = await bcrypt.hash(otp, 10);
  await Otp.findOneAndReplace(
    { email },
    {
      email,
      otpHash,
      expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
      attempts: 1,
    },
    { upsert: true, returnDocument: 'after' }
  );
  if (process.env.NODE_ENV === 'production') await sendOtpEmail(email, otp);
  return { email };
}

export async function verifyEmail({ email, otp }) {
  const record = await Otp.findOne({ email });
  if (!record) throw { status: 400, message: 'No OTP found for this email' };
  if (record.expiresAt < new Date())
    throw { status: 400, message: 'OTP has expired' };

  const valid = await bcrypt.compare(otp, record.otpHash);
  if (!valid) throw { status: 400, message: 'Invalid OTP' };

  let user = await User.findOne({ email });
  if (!user) throw { status: 404, message: 'User not found' };

  // Create tenant if not already linked
  if (!user.tenantId) {
    const tenant = await Tenant.create({ name: user.fullName || user.email });
    user.tenantId = tenant._id;
  }
  user.isVerified = true;
  await user.save();

  await Otp.deleteOne({ email });
  const tenant = await Tenant.findById(user.tenantId);
  const token = generateToken(user._id);
  return {
    token,
    user: {
      _id: user._id,
      fullName: user.fullName,
      email: user.email,
      isVerified: user.isVerified,
    },
    apiKey: tenant?.apiKey ?? null,
  };
}

export async function login({ email, password }) {
  const user = await User.findOne({ email }).select('+password');
  if (!user) throw { status: 401, message: 'Invalid credentials' };

  const match = await bcrypt.compare(password, user.password);
  if (!match) throw { status: 401, message: 'Invalid credentials' };

  const tenant = user.tenantId ? await Tenant.findById(user.tenantId) : null;
  const token = generateToken(user._id);
  return {
    token,
    user: {
      _id: user._id,
      fullName: user.fullName,
      email: user.email,
      isVerified: user.isVerified,
    },
    apiKey: tenant?.apiKey ?? null,
  };
}

export async function forgotPassword(email) {
  const user = await User.findOne({ email });
  if (!user) throw { status: 404, message: 'No account found with that email' };

  const existing = await Otp.findOne({ email });
  if (existing && existing.attempts >= OTP_MAX_ATTEMPTS) {
    throw { status: 429, message: 'Too many OTP requests. Try again later.' };
  }

  const otp =
    process.env.NODE_ENV === 'production'
      ? String(Math.floor(100000 + Math.random() * 900000))
      : '123456';
  const otpHash = await bcrypt.hash(otp, 10);

  await Otp.findOneAndReplace(
    { email },
    {
      email,
      otpHash,
      expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
      attempts: (existing?.attempts ?? 0) + 1,
    },
    { upsert: true, returnDocument: 'after' }
  );

  if (process.env.NODE_ENV === 'production') await sendOtpEmail(email, otp);
}

export async function resetPassword({ email, otp, newPassword }) {
  const record = await Otp.findOne({ email });
  if (!record) throw { status: 400, message: 'No OTP found for this email' };
  if (record.expiresAt < new Date())
    throw { status: 400, message: 'OTP has expired' };

  const valid = await bcrypt.compare(otp, record.otpHash);
  if (!valid) throw { status: 400, message: 'Invalid OTP' };

  const user = await User.findOne({ email }).select('+password');
  if (!user) throw { status: 404, message: 'User not found' };

  user.password = newPassword;
  await user.save();
  await Otp.deleteOne({ email });
}
