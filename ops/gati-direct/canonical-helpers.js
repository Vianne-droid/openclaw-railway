const GATI_DIRECT_WORKSPACE = "/home/openclaw/.openclaw/workspace";
const GATI_DIRECT_RESPONSE_SCRIPT = `${GATI_DIRECT_WORKSPACE}/scripts/sje-cache-response.py`;
const GATI_DIRECT_VISUAL_SCRIPT = `${GATI_DIRECT_WORKSPACE}/scripts/sje-gemini-visual-match.py`;
const GATI_DIRECT_LOG_PATH = "/data/.openclaw/logs/gati-sje-direct-ingress.jsonl";
const GATI_DIRECT_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/data/.openclaw/openclaw.json";
const GATI_DIRECT_RECENT = /* @__PURE__ */ new Map();
function normalizeGatiDirectSku(text) {
	let q = String(text || "").trim();
	if (!q || q.length > 120 || /\s/.test(q)) return null;
	const upper = q.toUpperCase();
	if (/^VJ[A-Z]{1,4}\d{3,6}$/.test(upper)) return upper;
	if (/^[A-Z]{1,5}\d{3,6}$/.test(upper)) return upper;
	if (/^[A-Z0-9]{2,8}-[A-Z0-9+.-]{4,}$/i.test(q)) return q;
	return null;
}
function extractGatiDirectSkus(text, limit = 8) {
	const tokens = String(text || "").split(/[\s,;/]+/).map((token) => token.replace(/^[`"'([{]+|[`"')\]}.,:!?]+$/g, "").trim()).filter(Boolean);
	const codes = [];
	const seen = /* @__PURE__ */ new Set();
	for (const token of tokens) {
		const code = normalizeGatiDirectSku(token);
		if (!code || seen.has(code)) continue;
		seen.add(code);
		codes.push(code);
		if (codes.length >= limit) break;
	}
	return codes;
}
function chunkGatiDirectText(text, max = 3800) {
	const input = String(text || "");
	if (input.length <= max) return [input];
	const chunks = [];
	let rest = input;
	while (rest.length > max) {
		let cut = rest.lastIndexOf("\n", max);
		if (cut < Math.floor(max * 0.6)) cut = max;
		chunks.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest) chunks.push(rest);
	return chunks;
}
async function appendGatiDirectIngressLog(record) {
	try {
		const fs = await import("node:fs/promises");
		await fs.mkdir("/data/.openclaw/logs", { recursive: true });
		await fs.appendFile(GATI_DIRECT_LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n", "utf8");
	} catch {}
}
async function execGatiDirectFile(command, args, options) {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	return promisify(execFile)(command, args, options);
}
function escapeGatiTelegramHtml(value) {
	return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function shouldBoldGatiLine(line) {
	return /^🦞\s+.+\s+—\s+(Fast SJE Lookup|Full SJE Details|SJE Lookup|Style.*)/.test(line) || /^(PIECE SUMMARY|COMPONENTS - READABLE|COMPONENT TOTALS|STOCK \/ BASE SOURCE ROW|STATUS \/ TRANSACTION|CHECK BEFORE USING|STYLE MATCHES|TRANSACTION HISTORY)$/.test(line) || /^(Diamonds|Metals|Other Components)\s+—/.test(line);
}
function toGatiTelegramHtml(text) {
	return String(text || "").split("\n").map((line) => {
		if (!line.trim()) return "";
		const escaped = escapeGatiTelegramHtml(line);
		if (shouldBoldGatiLine(line.trim())) return `<b>${escaped}</b>`;
		const field = escaped.match(/^(•\s*)([^:]{1,48}:)(.*)$/);
		if (field) return `${field[1]}<b>${field[2]}</b>${field[3]}`;
		return escaped;
	}).join("\n");
}
async function execGatiTelegramApi(method, args, options) {
	const { stdout } = await execGatiDirectFile("curl", ["-sS", "-X", "POST", method, ...args], options);
	let parsed;
	try {
		parsed = JSON.parse(stdout || "{}");
	} catch {
		throw new Error(`Telegram API returned non-JSON response: ${String(stdout || "").slice(0, 200)}`);
	}
	if (!parsed.ok) throw new Error(`Telegram API error: ${parsed.description || String(stdout || "").slice(0, 200)}`);
	return parsed;
}
async function loadGatiDirectToken() {
	const fs = await import("node:fs/promises");
	const raw = await fs.readFile(GATI_DIRECT_CONFIG_PATH, "utf8");
	const cfg = JSON.parse(raw);
	const token = cfg?.channels?.telegram?.accounts?.["gati-sje"]?.botToken;
	if (typeof token === "string" && token.trim()) return token.trim();
	throw new Error("gati-sje Telegram bot token not found");
}
async function sendGatiDirectMessage(token, chatId, text) {
	for (const chunk of chunkGatiDirectText(text)) {
		await execGatiTelegramApi(`https://api.telegram.org/bot${token}/sendMessage`, [
			"-d",
			`chat_id=${chatId}`,
			"--data-urlencode",
			`text=${toGatiTelegramHtml(chunk)}`,
			"-d",
			"parse_mode=HTML",
			"-d",
			"disable_web_page_preview=true"
		], { timeout: 1e4, maxBuffer: 512 * 1024 });
	}
}
async function sendGatiDirectPhoto(token, chatId, path, caption) {
	await execGatiTelegramApi(`https://api.telegram.org/bot${token}/sendPhoto`, [
		"-F",
		`chat_id=${chatId}`,
		"-F",
		`photo=@${path}`,
		"-F",
		`caption=${caption}`
	], { timeout: 15e3, maxBuffer: 512 * 1024 });
}
async function downloadGatiDirectTelegramFile(token, fileId) {
	const fs = await import("node:fs/promises");
	const pathMod = await import("node:path");
	const parsed = await execGatiTelegramApi(`https://api.telegram.org/bot${token}/getFile`, [
		"-d",
		`file_id=${fileId}`
	], { timeout: 1e3, maxBuffer: 512 * 1024 });
	const remotePath = parsed?.result?.file_path;
	if (!remotePath) throw new Error("Telegram getFile did not return file_path");
	const tmpDir = await fs.mkdtemp("/tmp/gati-sje-image-");
	const ext = pathMod.extname(remotePath) || ".jpg";
	const localPath = pathMod.join(tmpDir, `input${ext}`);
	await execGatiDirectFile("curl", [
		"-sS",
		"-L",
		"-o",
		localPath,
		`https://api.telegram.org/file/bot${token}/${remotePath}`
	], { timeout: 3e3, maxBuffer: 512 * 1024 });
	return localPath;
}
function extractGatiDirectPhotoFileId(context) {
	const payload = context?.ctxPayload || {};
	const chunks = [
		payload.RawBody,
		payload.Body,
		payload.Text,
		payload.Caption,
		payload.caption,
		payload.text
	].filter(Boolean).map(String);
	try {
		chunks.push(JSON.stringify(payload));
	} catch {}
	for (const chunk of chunks) {
		let match = chunk.match(/telegram:file\/([A-Za-z0-9_-]{20,})/);
		if (match?.[1]) return match[1];
		match = chunk.match(/"file_id"\s*:\s*"([^"]{20,})"/);
		if (match?.[1]) return match[1];
		match = chunk.match(/"fileId"\s*:\s*"([^"]{20,})"/);
		if (match?.[1]) return match[1];
	}
	return null;
}
async function sendGatiDirectLookup(token, chatId, query, note = "") {
	const itemStarted = Date.now();
	const { stdout } = await execGatiDirectFile("python3", [GATI_DIRECT_RESPONSE_SCRIPT, query], {
		cwd: GATI_DIRECT_WORKSPACE,
		timeout: 6e3,
		maxBuffer: 2 * 1024 * 1024
	});
	const lookupMs = Date.now() - itemStarted;
	const data = JSON.parse(stdout);
	if (!data?.found) return { query, found: false, lookupMs };
	const timings = { lookupMs };
	const image = Array.isArray(data.images) ? data.images[0] : null;
	if (image) {
		const imageStarted = Date.now();
		try {
			await sendGatiDirectPhoto(token, chatId, image, `🦞 ${data.query || query} / image`);
		} catch {
			await sendGatiDirectPhoto(token, chatId, image, `🦞 ${data.query || query} / image`);
		}
		timings.imageMs = Date.now() - imageStarted;
	}
	const fullStarted = Date.now();
	await sendGatiDirectMessage(token, chatId, note ? `${note}\n\n${data.full_text}` : data.full_text);
	timings.fullMs = Date.now() - fullStarted;
	timings.totalMs = Date.now() - itemStarted;
	return { query, found: true, image, counts: data.counts, timings };
}
function formatGatiVisualSummary(match) {
	const confidence = String(match?.confidence || "low").toUpperCase();
	const designConfidence = String(match?.design_confidence || match?.confidence || "low").toUpperCase();
	const lines = [
		`🦞 Gemini visual match — ${confidence}`,
		`• Design confidence: ${designConfidence}`,
		`• Best style: ${match?.winner_style_code || "none"}`
	];
	if (Array.isArray(match?.ambiguous_high_style_codes) && match.ambiguous_high_style_codes.length) {
		lines.push(`• Exact style ambiguous: ${match.ambiguous_high_style_codes.join(", ")}`);
	}
	if (match?.reason) lines.push(`• Reason: ${match.reason}`);
	const candidates = Array.isArray(match?.candidates) ? match.candidates.slice(0, 3) : [];
	if (candidates.length) {
		lines.push("");
		lines.push("Top candidates:");
		for (const candidate of candidates) {
			const score = Number(candidate.score || 0).toFixed(4);
			lines.push(`• #${candidate.rank}: ${candidate.style_code} (${candidate.category || "unknown"}, local score ${score})`);
		}
	}
	if (confidence !== "HIGH") lines.push("\nSend a tag/SKU or another angle if you want me to lock the exact piece.");
	return lines.join("\n");
}
async function sendGatiVisualCandidatePhotos(token, chatId, candidates) {
	for (const candidate of (Array.isArray(candidates) ? candidates.slice(0, 3) : [])) {
		if (!candidate?.path_abs) continue;
		await sendGatiDirectPhoto(token, chatId, candidate.path_abs, `🦞 Candidate #${candidate.rank}: ${candidate.style_code}`);
	}
}
async function handleGatiSjeDirectImageIngress(accountId, chatId, token, fileId, started) {
	const claimKey = `${chatId}:image:${fileId}`;
	const now = Date.now();
	for (const [key, value] of GATI_DIRECT_RECENT.entries()) if (now - value > 12e4) GATI_DIRECT_RECENT.delete(key);
	if (GATI_DIRECT_RECENT.has(claimKey)) return true;
	GATI_DIRECT_RECENT.set(claimKey, now);
	try {
		const downloadStarted = Date.now();
		const localImage = await downloadGatiDirectTelegramFile(token, fileId);
		const downloadMs = Date.now() - downloadStarted;
		const visualStarted = Date.now();
		const { stdout } = await execGatiDirectFile("python3", [
			GATI_DIRECT_VISUAL_SCRIPT,
			"--image",
			localImage,
			"--top",
			"10",
			"--candidate-images",
			"8",
			"--json"
		], {
			cwd: GATI_DIRECT_WORKSPACE,
			timeout: 24e4,
			maxBuffer: 4 * 1024 * 1024
		});
		const visualMs = Date.now() - visualStarted;
		const match = JSON.parse(stdout);
		if (!match?.ok) {
			await appendGatiDirectIngressLog({ accountId, chatId, image: true, handled: false, error: match?.error || "visual_match_failed", downloadMs, visualMs, totalMs: Date.now() - started });
			await sendGatiDirectMessage(token, chatId, "🦞 I could not confidently match this photo. Send another angle, tag, SKU, or clearer close-up.");
			return true;
		}
		const note = formatGatiVisualSummary(match);
		if (match.confidence === "high" && match.winner_style_code) {
			const result = await sendGatiDirectLookup(token, chatId, match.winner_style_code, note);
			await appendGatiDirectIngressLog({ accountId, chatId, image: true, handled: true, match: { winner: match.winner_style_code, confidence: match.confidence, designConfidence: match.design_confidence, ambiguous: match.ambiguous_high_style_codes }, lookup: result, downloadMs, visualMs, totalMs: Date.now() - started });
			return true;
		}
		await sendGatiDirectMessage(token, chatId, note);
		await sendGatiVisualCandidatePhotos(token, chatId, match.candidates);
		await appendGatiDirectIngressLog({ accountId, chatId, image: true, handled: true, match: { winner: match.winner_style_code, confidence: match.confidence, designConfidence: match.design_confidence, ambiguous: match.ambiguous_high_style_codes }, downloadMs, visualMs, totalMs: Date.now() - started });
		return true;
	} catch (err) {
		GATI_DIRECT_RECENT.delete(claimKey);
		await appendGatiDirectIngressLog({ accountId, chatId, image: true, handled: false, error: err instanceof Error ? err.message : String(err), totalMs: Date.now() - started });
		await sendGatiDirectMessage(token, chatId, "🦞 Image lookup hit an internal error. Send the SKU/tag if you have it, or try another photo.");
		return true;
	}
}
async function tryHandleGatiSjeDirectIngress(context, account) {
	const accountId = account?.accountId || account?.id;
	const body = context?.ctxPayload?.RawBody || "";
	const queries = extractGatiDirectSkus(body, 8);
	const chatType = String(context?.ctxPayload?.ChatType || "").toLowerCase();
	if (accountId !== "gati-sje" || !["direct", "group"].includes(chatType)) return false;
	const chatId = String(context.chatId || "").trim();
	const started = Date.now();
	const fileId = !queries.length ? extractGatiDirectPhotoFileId(context) : null;
	if (!queries.length && !fileId) return false;
	let token;
	try {
		token = await loadGatiDirectToken();
	} catch (err) {
		await appendGatiDirectIngressLog({ accountId, chatId, handled: false, error: err instanceof Error ? err.message : String(err), totalMs: Date.now() - started });
		return false;
	}
	if (!queries.length && fileId) return handleGatiSjeDirectImageIngress(accountId, chatId, token, fileId, started);
	if (!queries.length) return false;
	const claimKey = `${chatId}:${queries.join(",")}`;
	const now = Date.now();
	for (const [key, value] of GATI_DIRECT_RECENT.entries()) if (now - value > 12e4) GATI_DIRECT_RECENT.delete(key);
	if (GATI_DIRECT_RECENT.has(claimKey)) return true;
	GATI_DIRECT_RECENT.set(claimKey, now);
	try {
		const results = [];
		for (const query of queries) {
			const result = await sendGatiDirectLookup(token, chatId, query);
			await appendGatiDirectIngressLog({ accountId, chatId, query, found: result.found, image: result.image, counts: result.counts, timings: result.timings, lookupMs: result.lookupMs });
			results.push({ query, found: result.found });
		}
		await appendGatiDirectIngressLog({ accountId, chatId, queries, handled: true, results, totalMs: Date.now() - started });
		return results.some((result) => result.found);
	} catch (err) {
		GATI_DIRECT_RECENT.delete(claimKey);
		await appendGatiDirectIngressLog({ accountId, chatId, queries, found: false, error: err instanceof Error ? err.message : String(err), totalMs: Date.now() - started });
		return false;
	}
}
