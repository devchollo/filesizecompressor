import express from "express";
import multer from "multer";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));

// ---------- IMAGE COMPRESSION ----------
app.post("/compress/image", upload.single("file"), async (req, res) => {
  try {
    const compressedBuffer = await sharp(req.file.buffer)
      .resize({ width: 800 }) // optional
      .jpeg({ quality: 70 })
      .toBuffer();

    res.set("Content-Type", "image/jpeg");
    res.send(compressedBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- VIDEO COMPRESSION ----------
import { v4 as uuidv4 } from "uuid";

app.post("/compress/video", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  const tmpInput = path.join(os.tmpdir(), `${uuidv4()}_${req.file.originalname}`);
  const tmpOutput = path.join(os.tmpdir(), `${uuidv4()}_compressed.mp4`);

  fs.writeFileSync(tmpInput, req.file.buffer);

  ffmpeg(tmpInput)
    .setFfmpegPath("C:\\ffmpeg\\bin\\ffmpeg.exe")
    .setFfprobePath("C:\\ffmpeg\\bin\\ffprobe.exe")
    .outputOptions(["-vcodec libx264", "-crf 28", "-preset veryfast"])
    .save(tmpOutput)
    .on("end", () => {
      // Send compressed video
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="compressed_${req.file.originalname}"`
      );
      const stream = fs.createReadStream(tmpOutput);
      stream.pipe(res);

      // Cleanup after sending
      stream.on("close", () => {
        fs.unlinkSync(tmpInput);
        fs.unlinkSync(tmpOutput);
      });
    })
    .on("error", (err) => {
      if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
      if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
      console.error("FFmpeg error:", err.message);
      res.status(500).send("Video compression failed");
    });
});

// ---------- AUDIO COMPRESSION ----------
app.post("/compress/audio", upload.single("file"), (req, res) => {
  const tmpFile = path.join(os.tmpdir(), req.file.originalname);
  fs.writeFileSync(tmpFile, req.file.buffer);

  res.set("Content-Type", "audio/mp3");

  ffmpeg(tmpFile)
    .audioBitrate("128k")
    .format("mp3")
    .on("end", () => fs.unlinkSync(tmpFile))
    .on("error", (err) => {
      fs.unlinkSync(tmpFile);
      res.status(500).json({ error: err.message });
    })
    .pipe(res, { end: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
