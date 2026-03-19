import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.MAILTRAP_HOST,
  port: Number(process.env.MAILTRAP_PORT),
  auth: {
    user: process.env.MAILTRAP_USER,
    pass: process.env.MAILTRAP_PASS,
  },
});

export async function sendOtpEmail(email, otp) {
  await transporter.sendMail({
    from: '"SaaS Migration" <no-reply@saas-migration.com>',
    to: email,
    subject: 'Your Password Reset OTP',
    text: `Your OTP is: ${otp}\n\nThis code expires in 5 minutes.`,
    html: `<p>Your OTP is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`,
  });
}
