import express from "express";
import multer from "multer";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import cors from "cors";

// ---------------- Setup ----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Use cross-platform FFmpeg from installer
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ---------------- CORS ----------------
const allowedOrigins = [
  "https://filesizecompressor.vercel.app",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // allow curl, mobile apps
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS origin not allowed"), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// Handle preflight requests
app.options("*", cors());

// ---------------- Request Logger ----------------
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// ---------------- IMAGE COMPRESSION ----------------
app.post("/compress/image", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("No file uploaded");

    const buffer = await sharp(req.file.buffer)
      .resize({ width: 800 })
      .jpeg({ quality: 70 })
      .toBuffer();

    res.setHeader("Content-Type", "image/jpeg");
    res.send(buffer);
  } catch (err) {
    console.error("Image compression error:", err);
    res.status(500).send("Image compression failed");
  }
});

// ---------------- VIDEO COMPRESSION ----------------
app.post("/compress/video", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  const tmpInput = path.join(os.tmpdir(), `${uuidv4()}_${req.file.originalname}`);
  fs.writeFileSync(tmpInput, req.file.buffer);

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="compressed_${req.file.originalname}"`
  );

  ffmpeg(tmpInput)
    .outputOptions(["-vcodec libx264", "-crf 28", "-preset veryfast"])
    .format("mp4")
    .on("error", (err) => {
      console.error("FFmpeg video error:", err);
      if (!res.headersSent) res.status(500).send("Video compression failed");
      fs.existsSync(tmpInput) && fs.unlinkSync(tmpInput);
    })
    .on("end", () => {
      fs.existsSync(tmpInput) && fs.unlinkSync(tmpInput);
    })
    .pipe(res, { end: true });
});

// ---------------- AUDIO COMPRESSION ----------------
app.post("/compress/audio", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  const tmpInput = path.join(os.tmpdir(), `${uuidv4()}_${req.file.originalname}`);
  fs.writeFileSync(tmpInput, req.file.buffer);

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="compressed_${req.file.originalname}.mp3"`
  );

  ffmpeg(tmpInput)
    .audioBitrate("128k")
    .format("mp3")
    .on("error", (err) => {
      console.error("FFmpeg audio error:", err);
      if (!res.headersSent) res.status(500).send("Audio compression failed");
      fs.existsSync(tmpInput) && fs.unlinkSync(tmpInput);
    })
    .on("end", () => {
      fs.existsSync(tmpInput) && fs.unlinkSync(tmpInput);
    })
    .pipe(res, { end: true });
});

// ---------------- Serve static frontend ----------------
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// ---------------- SPA fallback ----------------
app.get(/^(?!\/compress\/).*/, (req, res) => {
  // Only fallback if not a /compress route
  const indexHtml = path.join(publicDir, "index.html");
  if (fs.existsSync(indexHtml)) {
    res.sendFile(indexHtml);
  } else {
    res.status(404).send("Frontend not found");
  }
});

// ---------------- Catch-all 404 ----------------
app.all("*", (req, res) => res.status(404).send("Route not found"));

// ---------------- Start server ----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
