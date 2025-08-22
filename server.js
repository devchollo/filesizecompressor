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

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ---------------- CORS ----------------
const allowedOrigins = [
  "https://filesizecompressor.vercel.app",
  "http://localhost:3000", // dev
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS origin not allowed"), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
app.options("*", cors());

// ---------------- Request Logger ----------------
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// ---------------- FFmpeg codec detection & fallbacks ----------------
const CODEC_SUPPORT = {
  x264: false,
  mpeg4: false,
  mp3: false,
  aac: false,
  opus: false,
};

let VIDEO_CONFIG = { vCodec: "libx264", aCodec: "aac", container: "mp4" };
let AUDIO_CONFIG = { codec: "libmp3lame", container: "mp3", mime: "audio/mpeg" };

function logCodecPlan() {
  console.log("🎬 Video plan:", VIDEO_CONFIG);
  console.log("🎵 Audio plan:", AUDIO_CONFIG);
}

ffmpeg.getAvailableCodecs((err, codecs) => {
  if (err) {
    console.error("❌ Failed to query ffmpeg codecs:", err);
  } else {
    CODEC_SUPPORT.x264 = !!(codecs.libx264 && codecs.libx264.canEncode);
    CODEC_SUPPORT.mpeg4 = !!(codecs.mpeg4 && codecs.mpeg4.canEncode);
    CODEC_SUPPORT.mp3 = !!(codecs.libmp3lame && codecs.libmp3lame.canEncode);
    CODEC_SUPPORT.aac = !!(codecs.aac && codecs.aac.canEncode);
    CODEC_SUPPORT.opus = !!(codecs.libopus && codecs.libopus.canEncode);

    // Decide video codec/container
    if (CODEC_SUPPORT.x264) {
      VIDEO_CONFIG.vCodec = "libx264";
      VIDEO_CONFIG.container = "mp4";
    } else if (CODEC_SUPPORT.mpeg4) {
      // Widely available fallback (older MPEG-4 Part 2), larger files but works
      VIDEO_CONFIG.vCodec = "mpeg4";
      VIDEO_CONFIG.container = "mp4";
      console.warn("⚠️ Falling back to mpeg4 for video (libx264 not available).");
    } else {
      console.warn("⚠️ No preferred video encoder found; attempting libx264 anyway.");
    }

    // Decide video audio codec
    if (CODEC_SUPPORT.aac) {
      VIDEO_CONFIG.aCodec = "aac";
    } else if (CODEC_SUPPORT.mp3) {
      // mp3 in mp4 is not ideal, but many players accept it; prefer AAC when possible.
      VIDEO_CONFIG.aCodec = "libmp3lame";
      console.warn("⚠️ Using MP3 audio inside MP4 (AAC not available).");
    } else {
      VIDEO_CONFIG.aCodec = "copy";
      console.warn("⚠️ Copying source audio (no AAC/MP3 encoders available).");
    }

    // Decide audio endpoint defaults & MIME
    if (CODEC_SUPPORT.mp3) {
      AUDIO_CONFIG = { codec: "libmp3lame", container: "mp3", mime: "audio/mpeg" };
    } else if (CODEC_SUPPORT.aac) {
      AUDIO_CONFIG = { codec: "aac", container: "m4a", mime: "audio/mp4" };
      console.warn("⚠️ Falling back to AAC (.m4a) for audio endpoint (MP3 not available).");
    } else if (CODEC_SUPPORT.opus) {
      AUDIO_CONFIG = { codec: "libopus", container: "ogg", mime: "audio/ogg" };
      console.warn("⚠️ Falling back to Opus (.ogg) for audio endpoint (MP3/AAC not available).");
    } else {
      console.warn("❌ No suitable audio encoder found for audio endpoint.");
    }
  }

  logCodecPlan();
});

// ---------------- Helpers ----------------
const tmpFile = (ext = "") => path.join(os.tmpdir(), `${uuidv4()}${ext ? "." + ext : ""}`);
const cleanup = (files = []) =>
  files.forEach((f) => {
    try {
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
    } catch (_) {}
  });

// ---------------- IMAGE COMPRESSION ----------------
app.post("/compress/image", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("No file uploaded");

    // Tweak sizes/quality as you like or make it dynamic
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


app.post("/compress/video", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  const ext = VIDEO_CONFIG.container || "mp4";
  const outName = `compressed_${path.parse(req.file.originalname).name}.${ext}`;

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${outName}"`);

  ffmpeg()
    .input(req.file.buffer)
    .inputFormat(path.extname(req.file.originalname).slice(1) || "mp4")
    .outputOptions([
      `-vcodec ${VIDEO_CONFIG.vCodec}`, // libx264 / mpeg4
      "-preset ultrafast",              // much faster than superfast
      "-crf 32",                        // faster + smaller file, lower quality
      "-movflags +faststart",
      VIDEO_CONFIG.aCodec === "copy" ? "-an" : `-c:a ${VIDEO_CONFIG.aCodec}`,
      "-b:a 96k",                       // low bitrate audio
    ])
    .on("error", (err) => {
      console.error("FFmpeg video error:", err.message);
      if (!res.headersSent) res.status(500).send("Video compression failed");
    })
    .on("end", () => console.log("Video compression finished"))
    .pipe(res, { end: true }); // stream directly to response
});


app.post("/compress/audio", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  if (!CODEC_SUPPORT.mp3 && !CODEC_SUPPORT.aac && !CODEC_SUPPORT.opus)
    return res.status(501).send("No suitable audio encoder available");

  const ext = AUDIO_CONFIG.container || "mp3";
  const outName = `compressed_${path.parse(req.file.originalname).name}.${ext}`;

  res.setHeader("Content-Type", AUDIO_CONFIG.mime);
  res.setHeader("Content-Disposition", `attachment; filename="${outName}"`);

  const chain = ffmpeg()
    .input(req.file.buffer)
    .outputOptions([
      `-acodec ${AUDIO_CONFIG.codec}`,
      AUDIO_CONFIG.codec === "libmp3lame" ? "-b:a 96k" : "",
      AUDIO_CONFIG.codec === "aac" ? "-b:a 96k" : "",
      AUDIO_CONFIG.codec === "libopus" ? "-b:a 64k" : "",
    ])
    .on("error", (err) => {
      console.error("FFmpeg audio error:", err.message);
      if (!res.headersSent) res.status(500).send("Audio compression failed");
    })
    .on("end", () => console.log("Audio compression finished"))
    .pipe(res, { end: true }); // stream directly to response
});


// ---------------- Serve static frontend ----------------
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// ---------------- SPA fallback & catch-all ----------------
app.get("*", (req, res) => {
  if (req.path.startsWith("/compress/")) {
    return res.status(404).send("Route not found");
  }
  const indexHtml = path.join(publicDir, "index.html");
  if (fs.existsSync(indexHtml)) {
    res.sendFile(indexHtml);
  } else {
    res.status(404).send("Frontend not found");
  }
});

// ---------------- Log routes (debug) ----------------
app._router?.stack?.forEach((middleware) => {
  if (middleware.route) {
    const methods = Object.keys(middleware.route.methods)
      .map((m) => m.toUpperCase())
      .join(", ");
    console.log(`${methods} ${middleware.route.path}`);
  }
});

// ---------------- Start server ----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
