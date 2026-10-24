const mongoose = require('mongoose');

const resultSchema = new mongoose.Schema({
  rollNumber: { type: String, required: true, unique: true, trim: true, uppercase: true },
  studentName: { type: String, required: true, trim: true },
  course: { type: String, required: true, default: 'BCA' },
  semester: { type: String, required: true, default: 'Semester 5' },
  marks: {
    computerNetworks: { type: Number, required: true, min: 0, max: 100 },
    database: { type: Number, required: true, min: 0, max: 100 },
    webDevelopment: { type: Number, required: true, min: 0, max: 100 },
    java: { type: Number, required: true, min: 0, max: 100 },
    softwareEngineering: { type: Number, required: true, min: 0, max: 100 }
  },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('Result', resultSchema);
