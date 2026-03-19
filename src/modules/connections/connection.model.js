// src/modules/connections/connection.model.js
import mongoose from 'mongoose';
import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
const KEY_LENGTH = 32;

function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== KEY_LENGTH) {
    throw new Error(
      `ENCRYPTION_KEY must be set and exactly ${KEY_LENGTH} characters long`
    );
  }
  return Buffer.from(key, 'utf8');
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(ciphertext) {
  const [ivHex, encHex] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    'utf8'
  );
}

const SENSITIVE_FIELDS = {
  servicenow: 'password',
  freshservice: 'apiKey',
};

const connectionSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    name: { type: String, required: true },
    platform: {
      type: String,
      required: true,
      enum: ['servicenow', 'freshservice'],
    },
    credentials: { type: mongoose.Schema.Types.Mixed, required: true },
    lastTestedAt: { type: Date, default: null },
    lastTestStatus: {
      type: String,
      enum: ['success', 'failed', null],
      default: null,
    },
    lastTestError: { type: String, default: null },
  },
  { timestamps: true }
);

// Encrypt the sensitive credential field before every save
connectionSchema.pre('save', function (next) {
  const field = SENSITIVE_FIELDS[this.platform];
  if (!field) return next();

  const value = this.credentials?.[field];
  // Only encrypt if the value exists and is not already encrypted (no colon-hex pattern)
  if (value && !value.includes(':')) {
    this.credentials = { ...this.credentials, [field]: encrypt(value) };
  }
  next();
});

/**
 * Returns the document without decrypted credentials — masks the sensitive field.
 */
connectionSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  const field = SENSITIVE_FIELDS[obj.platform];
  if (field && obj.credentials?.[field]) {
    obj.credentials = { ...obj.credentials, [field]: '••••••••' };
  }
  return obj;
};

/**
 * Returns credentials with the sensitive field decrypted.
 */
connectionSchema.methods.getDecryptedCredentials = function () {
  const field = SENSITIVE_FIELDS[this.platform];
  if (!field) return { ...this.credentials };
  const encrypted = this.credentials?.[field];
  if (!encrypted) return { ...this.credentials };
  return { ...this.credentials, [field]: decrypt(encrypted) };
};

export default mongoose.model('Connection', connectionSchema);
