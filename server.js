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

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Use cross-platform FFmpeg
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ---------------- CORS ----------------
// Allow your frontend or all origins
app.use(
  cors({
    origin: "https://filesizecompressor.vercel.app", 
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
app.all("*", (req, res) => {
  res.status(404).send("Route not found");
});
app.options("*", cors()); 
// ---------------- Serve frontend (optional) ----------------
const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// ---------------- IMAGE COMPRESSION ----------------
app.post("/compress/image", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("No file uploaded");

    const buffer = await sharp(req.file.buffer)
      .resize({ width: 800 }) // optional resize
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
app.post("/compress/video", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  const tmpInput = path.join(os.tmpdir(), `${uuidv4()}_${req.file.originalname}`);
  const tmpOutput = path.join(os.tmpdir(), `${uuidv4()}_compressed.mp4`);

  try {
    fs.writeFileSync(tmpInput, req.file.buffer);

    ffmpeg(tmpInput)
      .outputOptions(["-vcodec libx264", "-crf 28", "-preset veryfast"])
      .save(tmpOutput)
      .on("end", () => {
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="compressed_${req.file.originalname}"`
        );

        const stream = fs.createReadStream(tmpOutput);
        stream.pipe(res).on("close", () => {
          fs.unlinkSync(tmpInput);
          fs.unlinkSync(tmpOutput);
        });
      })
      .on("error", (err) => {
        console.error("FFmpeg video error:", err);
        if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
        if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
        res.status(500).send("Video compression failed");
      });
  } catch (err) {
    console.error("Video processing error:", err);
    if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
    if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
    res.status(500).send("Server error");
  }
});

// ---------------- AUDIO COMPRESSION ----------------
app.post("/compress/audio", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  const tmpInput = path.join(os.tmpdir(), `${uuidv4()}_${req.file.originalname}`);
  fs.writeFileSync(tmpInput, req.file.buffer);

  try {
    ffmpeg(tmpInput)
      .audioBitrate("128k")
      .format("mp3")
      .on("end", () => fs.unlinkSync(tmpInput))
      .on("error", (err) => {
        console.error("FFmpeg audio error:", err);
        if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
        res.status(500).send("Audio compression failed");
      })
      .pipe(res, { end: true });
  } catch (err) {
    console.error("Audio processing error:", err);
    if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
    res.status(500).send("Server error");
  }
});

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
