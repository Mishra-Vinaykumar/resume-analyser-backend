import { Router } from "express";
import { cap } from "../utils/cap.js";
import { matchResumeToJob } from "../services/openaiMatch.js";

const router = Router();

router.post("/match-resume", async (req, res) => {
  try {
    const resume_text = cap(req.body?.resume_text, 18000).trim();
    const job_text = cap(req.body?.job_text, 18000).trim();
    const job_url = String(req.body?.job_url || "").trim();
    const job_title = String(req.body?.job_title || "").trim();
    const custom_prompt = String(req.body?.custom_prompt || "").trim();

    if (!resume_text) {
      return res.status(400).json({ error: "missing resume_text" });
    }

    if (!job_text) {
      return res.status(400).json({ error: "missing job_text" });
    }

    const result = await matchResumeToJob({
      resume_text,
      job_text,
      job_url,
      job_title,
      custom_prompt,
    });

    return res.json(result);
  } catch (err) {
    console.error("match-resume failed:", err);

    return res.status(500).json({
      error: "Matching failed",
      detail: err?.message || String(err),
    });
  }
});

export default router;