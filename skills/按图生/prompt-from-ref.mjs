#!/usr/bin/env node
// prompt-from-ref.mjs — reverse-engineer a Nano Banana 2 prompt from a reference image
//
// Usage:
//   node prompt-from-ref.mjs --ref <image> [--subject "新主题"] [--out -|<file>] [--provider anthropic|openai] [--verbose]
//
// Env (one of):
//   ANTHROPIC_API_KEY                            → uses Anthropic /v1/messages
//   OPENAI_API_KEY + OPENAI_BASE_URL             → uses OpenAI-compatible /chat/completions
// Optional:
//   STYLE_GEN_API_BASE   overrides default base URL
//   STYLE_GEN_MODEL      overrides default model (defaults: claude-sonnet-4-6 / gpt-4o)
//
// Clean-room reimplementation. The 12-field schema is a generic categorization
// approach for visual description (commonly used in concept art / VFX briefs);
// the wording below is rewritten from scratch for our Nano Banana 2 pipeline.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

const SYSTEM_PROMPT = `Role: forensic prompt reconstructor. Your job is to look at the supplied reference image and write a faithful Chinese prompt that another image model can use to regenerate something visually close to it. This is reverse-engineering, not creative writing.

Output strictly the following JSON object (no markdown fences, no prose around it):

{
  "zh_prompt": "<single natural-language Chinese paragraph, 100-150 characters worth of dense visual description, NO field labels inside>",
  "fields": {
    "subject": "<what the main subject(s) are: count, identity, scale, most prominent visible attributes>",
    "action_pose": "<pose, gesture, gaze, orientation, placement of objects>",
    "details_appearance": "<concrete visible details: clothing, design lines, props, markings, silhouette>",
    "environment_background": "<background, foreground/midground/background relationship, depth, surrounding elements>",
    "lighting_atmosphere": "<light direction, hardness, contrast, color temperature, mood>",
    "composition_framing": "<shot distance, angle, crop, subject placement, negative space, perspective>",
    "style_camera": "<visual medium, aesthetic style, level of realism/stylization, render or photographic feel>",
    "colors": "<2-4 dominant colors in plain color names, e.g. violet, royal blue, ivory>",
    "materials": "<material types and surface finish in plain language>",
    "aspect_ratio": "<e.g. 16:9, 1:1, 3:4 — matched to the reference>",
    "quality_finish": "<concrete finish cues grounded in what is visible, not filler like 'highly detailed'>",
    "likely_generation_intent": "<one phrase: what visual purpose the original was optimized for — e.g. 'modern UI/UX showcase', 'magazine cover atmosphere', 'app icon system'>"
  },
  "verbatim_text": "<any Chinese / English text visible in the image, copied character-for-character; empty string if none>"
}

Hard rules:
1. zh_prompt is the deliverable. The "fields" object exists to make sure you covered every angle before writing the paragraph. zh_prompt itself MUST be a flowing natural-language paragraph with NO field labels, NO colons-as-headers.
2. Stay grounded in what is visible. Do not invent: camera bodies, lens specs, render engines (e.g. Octane / V-Ray), artist names, geographic locations, or brand names — unless visibly evidenced.
3. If unsure about a detail, use broader but still useful wording. Vague is fine; fabrication is not.
4. Forbidden generic filler that adds no visual info: "highly detailed", "masterpiece", "8k", "best quality", "极致细节", "大师之作". Skip these.
5. For multiple subjects, describe each subject's geometry / form individually — not just a list of names.
6. If the image contains text (titles, captions, labels), copy them character-for-character into verbatim_text AND include the exact text inside zh_prompt where it appears spatially. Chinese characters must be preserved verbatim; do not translate, rephrase, or summarize.
7. Reverse any "NO X" temptation into a positive statement. Write "纯图形与文字排版，无人物或场景" instead of "no people, no scene".
8. End zh_prompt with a short clause that captures the likely_generation_intent — this anchors the overall visual direction for the downstream image model.
9. zh_prompt and the fields must be in Simplified Chinese. Do not mix English into zh_prompt unless the image itself contains English text that must be preserved verbatim.
`;

// ---- argv parse ----
const argv = Object.fromEntries(
  process.argv.slice(2).reduce((acc, tok, i, arr) => {
    if (tok.startsWith("--")) acc.push([tok.slice(2), arr[i + 1] ?? true]);
    return acc;
  }, [])
);

if (!argv.ref) {
  console.error("usage: node prompt-from-ref.mjs --ref <image> [--subject \"<新主题>\"] [--out -|<file>] [--provider anthropic|openai] [--verbose]");
  process.exit(1);
}

const REF = resolve(argv.ref);
const SUBJECT = typeof argv.subject === "string" ? argv.subject : null;
const OUT = typeof argv.out === "string" ? argv.out : "-";
const VERBOSE = !!argv.verbose;

if (!existsSync(REF)) { console.error(`ref not found: ${REF}`); process.exit(2); }

const log = (...a) => { if (VERBOSE) console.error("[prompt-from-ref]", ...a); };

// Decide provider — explicit flag > Anthropic key > OpenAI key
const PROVIDER = (typeof argv.provider === "string")
  ? argv.provider
  : (process.env.ANTHROPIC_API_KEY ? "anthropic"
    : (process.env.OPENAI_API_KEY ? "openai" : null));

if (!PROVIDER) {
  console.error("no API credentials in env. Set one of:");
  console.error("  ANTHROPIC_API_KEY=<key>   # uses claude-sonnet-4-6 by default");
  console.error("  OPENAI_API_KEY=<key> OPENAI_BASE_URL=<url>   # uses gpt-4o by default");
  process.exit(3);
}

// ---- resize if too big (macOS sips) ----
function maybeResize(srcPath) {
  let info;
  try {
    info = execSync(`sips -g pixelWidth -g pixelHeight "${srcPath}"`, { encoding: "utf8" });
  } catch { return srcPath; }
  const w = Number(info.match(/pixelWidth:\s*(\d+)/)?.[1] || 0);
  const h = Number(info.match(/pixelHeight:\s*(\d+)/)?.[1] || 0);
  const stat = statSync(srcPath);
  const maxDim = Math.max(w, h);
  log(`ref: ${w}x${h}, ${stat.size} bytes`);
  if (maxDim <= 2200 && stat.size <= 1024 * 1024) return srcPath;
  const tmp = join(tmpdir(), `prompt-from-ref-${Date.now()}.jpg`);
  log(`resizing → ${tmp}`);
  execSync(`sips -Z 2048 -s format jpeg -s formatOptions 80 "${srcPath}" --out "${tmp}"`, { stdio: "ignore" });
  return tmp;
}

const refPath = maybeResize(REF);
const refBuf = readFileSync(refPath);
const refB64 = refBuf.toString("base64");
const refMime = /\.png$/i.test(refPath) ? "image/png" :
                /\.gif$/i.test(refPath) ? "image/gif" :
                "image/jpeg";

const userText = SUBJECT
  ? `Reconstruct the original generation prompt for the reference image, BUT swap the subject to: "${SUBJECT}". Keep every other visual element tied to the reference (composition, lighting, materials, colors, mood, framing). Only the Subject / Action/Pose / Details fields should reflect the new subject; all other fields should describe the reference image's visual style. Output JSON only.`
  : `Reconstruct the original generation prompt for this reference image as instructed. Output JSON only.`;

function extractJson(text) {
  let s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return (a === -1 || b <= a) ? s : s.slice(a, b + 1).trim();
}

// ---- call LLM ----
let raw = "";
if (PROVIDER === "anthropic") {
  const base = (process.env.STYLE_GEN_API_BASE || "https://api.anthropic.com").replace(/\/$/, "");
  const model = process.env.STYLE_GEN_MODEL || "claude-sonnet-4-6";
  log(`anthropic ${base} model=${model}`);
  const r = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: 6000,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: refMime, data: refB64 } },
          { type: "text", text: userText }
        ]
      }]
    })
  });
  if (!r.ok) {
    console.error(`Anthropic API ${r.status}: ${(await r.text()).slice(0, 800)}`);
    process.exit(4);
  }
  const j = await r.json();
  raw = j.content?.[0]?.text || "";
} else {
  // openai-compatible
  const base = (process.env.OPENAI_BASE_URL || process.env.STYLE_GEN_API_BASE || "").replace(/\/$/, "");
  if (!base) { console.error("OPENAI_BASE_URL not set"); process.exit(3); }
  const model = process.env.STYLE_GEN_MODEL || "gpt-4o";
  log(`openai-compatible ${base} model=${model}`);
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 6000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: [
          { type: "image_url", image_url: { url: `data:${refMime};base64,${refB64}` } },
          { type: "text", text: userText }
        ]}
      ]
    })
  });
  if (!r.ok) {
    console.error(`OpenAI API ${r.status}: ${(await r.text()).slice(0, 800)}`);
    process.exit(4);
  }
  const j = await r.json();
  raw = j.choices?.[0]?.message?.content || "";
}

log(`raw response: ${raw.length} chars`);
if (VERBOSE) console.error("---first 500---\n" + raw.slice(0, 500));

let parsed;
try {
  parsed = JSON.parse(extractJson(raw));
} catch (e) {
  console.error(`failed to parse JSON: ${e.message}`);
  console.error("raw preview:", raw.slice(0, 1500));
  process.exit(5);
}

const promptZh = parsed?.zh_prompt?.trim();
if (!promptZh) {
  console.error("model returned JSON but zh_prompt is missing");
  console.error("keys:", Object.keys(parsed || {}));
  process.exit(6);
}

if (OUT === "-") {
  process.stdout.write(promptZh);
} else {
  writeFileSync(OUT, promptZh);
  log(`saved ${promptZh.length} chars to ${OUT}`);
}
