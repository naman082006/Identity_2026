require('dotenv').config();
const mongoose = require('mongoose');
const Result = require('../models/Result');
const demoResults = [
  { rollNumber: 'RS2026001', studentName: 'Aarav Sharma', course: 'BCA', semester: 'Semester 5', marks: { computerNetworks: 88, database: 91, webDevelopment: 86, java: 84, softwareEngineering: 90 } },
  { rollNumber: 'RS2026002', studentName: 'Priya Verma', course: 'BCA', semester: 'Semester 5', marks: { computerNetworks: 78, database: 82, webDevelopment: 89, java: 76, softwareEngineering: 85 } },
  { rollNumber: 'RS2026003', studentName: 'Kabir Singh', course: 'BCA', semester: 'Semester 5', marks: { computerNetworks: 65, database: 71, webDevelopment: 74, java: 69, softwareEngineering: 72 } }
];
(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/resultshield');
    for (const item of demoResults) await Result.findOneAndUpdate({ rollNumber: item.rollNumber }, item, { upsert: true, new: true, runValidators: true });
    console.log('Demo results added/updated successfully. Test roll numbers: RS2026001, RS2026002, RS2026003');
  } catch (error) { console.error('Seed failed:', error.message); process.exitCode = 1; }
  finally { await mongoose.disconnect(); }
})();
