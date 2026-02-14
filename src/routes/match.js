import { Router } from "express";
import { cap } from "../utils/cap.js";
import { detectOptBlocker } from "../utils/optBlockers.js";
import { matchResumeToJob } from "../services/openaiMatch.js";

const router = Router();

function blockerTypeToHuman(blocker_type) {
  switch (blocker_type) {
    case "security_clearance":
      return "security clearance";
    case "citizenship_required":
      return "U.S. citizenship";
    case "permanent_residency":
      return "permanent residency (green card/LPR)";
    case "government_restriction":
      return "government/federal authorization restrictions";
    case "export_control":
      return "ITAR/export control restrictions";
    default:
      return "restricted work authorization requirement";
  }
}

router.post("/match-resume", async (req, res) => {
  try {
    // Use a larger cap for blocker scan to reduce false negatives
    const job_text_for_blockers = cap(req.body?.job_text, 60000).trim();

    const resume_text = cap(req.body?.resume_text, 18000).trim();
    const job_text = cap(req.body?.job_text, 18000).trim(); // used for matching
    const job_url = String(req.body?.job_url || "");
    const job_title = String(req.body?.job_title || "");

    if (!resume_text) return res.status(400).json({ error: "missing resume_text" });
    if (!job_text_for_blockers) return res.status(400).json({ error: "missing job_text" });

    // STEP 0: *CRITICAL BLOCKER CHECK* (hard stop)
    const blocker = detectOptBlocker(job_text_for_blockers);
    if (blocker) {
      const position = job_title || "Not provided";
      const company = "Not provided";
      const human = blockerTypeToHuman(blocker.blocker_type);

      const report = `BLOCKER ALERT:
"""
🚫 APPLICATION REJECTED - CRITICAL BLOCKER DETECTED

Position: ${position}
Company: ${company}

BLOCKER IDENTIFIED:
- ${blocker.blocker_text}

REASON FOR REJECTION:
This position requires ${human} which is NOT available to OPT/STEM OPT candidates on F-1 visa status.

OPT/F-1 visa holders CANNOT:
- Obtain security clearances (any level)
- Meet U.S. citizenship requirements
- Work on federal government contracts requiring citizenship
- Comply with ITAR/export control restrictions
- Meet "green card required" stipulations

RECOMMENDATION: ⛔ DO NOT APPLY - Skip this position entirely

---
Would you like me to analyze a different job posting?
"""`;

      return res.json({
        status: "REJECTED",
        p: 0,
        report,
        json: {
          status: "REJECTED",
          blocker_type: blocker.blocker_type,
          blocker_text: blocker.blocker_text,
          match_score: null,
          eligible_for_opt: false,
          recommendation: "DO_NOT_APPLY",
          reason: `Position requires ${human} which OPT/F-1 visa holders cannot fulfill`
        }
      });
    }

    // If no blocker → proceed to Step 1–8 matching
    const result = await matchResumeToJob({ resume_text, job_text, job_url, job_title });
    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Matching failed",
      detail: err?.message || String(err)
    });
  }
});

export default router;
