import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const tenantSchema = new mongoose.Schema(
  {
    name: {
      type: String,
    },
    apiKey: {
      type: String,
      default: uuidv4,
      unique: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model('Tenant', tenantSchema);
