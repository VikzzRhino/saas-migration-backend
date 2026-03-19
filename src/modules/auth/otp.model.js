import mongoose from 'mongoose';

const otpSchema = new mongoose.Schema({
  email: { type: String, lowercase: true },
  otpHash: String,
  expiresAt: Date,
  attempts: { type: Number, default: 0 },
});

otpSchema.index({ email: 1 });
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('Otp', otpSchema);
