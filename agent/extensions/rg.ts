import { spawn } from "node:child_process";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type TextOrBytes = {
	text?: string;
	bytes?: string;
};

type Submatch = {
	match?: TextOrBytes;
	start?: number;
	end?: number;
};

type SearchEvent = {
	kind: "match" | "context";
	path: string;
	lineNumber: number | null;
	text: string;
	submatches: Array<{
		text: string;
		start: number | null;
		end: number | null;
	}>;
};

type FileMatchSummary = {
	path: string;
	matchCount: number;
};

type SearchResult = {
	resolvedPath: string;
	matchCount: number;
	fileCount: number;
	previewEvents: SearchEvent[];
	totalEventCount: number;
	topFiles: FileMatchSummary[];
	truncated: boolean;
	exitCode: number | null;
	stderr: string;
};

const MAX_LINE_TEXT = 140;
const MAX_SUMMARY_TEXT = 240;
const MAX_CONTENT_CHARS = 1800;
const DEFAULT_LIMIT = 20;
const DEFAULT_PREVIEW_EVENTS = 8;
const MAX_TOP_FILES = 5;

function normalizePathInput(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const trimmed = path.trim();
	if (!trimmed) return undefined;
	return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function decodeTextOrBytes(value: TextOrBytes | undefined): string {
	if (!value) return "";
	if (typeof value.text === "string") return value.text;
	if (typeof value.bytes === "string") {
		try {
			return Buffer.from(value.bytes, "base64").toString("utf8");
		} catch {
			return "";
		}
	}
	return "";
}

function trimText(text: string, maxChars: number): string {
	const singleLine = text.replace(/\r?\n/g, "\\n");
	if (singleLine.length <= maxChars) return singleLine;
	return `${singleLine.slice(0, Math.max(0, maxChars - 3))}...`;
}

function trimLine(text: string): string {
	return trimText(text, MAX_LINE_TEXT);
}

function formatEvent(event: SearchEvent): string {
	const prefix = event.kind === "context" ? "-" : ":";
	const lineNumber = event.lineNumber ?? "?";
	return `${event.path}:${lineNumber}${prefix} ${trimLine(event.text)}`;
}

function formatTopFiles(topFiles: FileMatchSummary[]): string {
	return trimText(topFiles.map((file) => `${file.path} (${file.matchCount})`).join(", "), MAX_SUMMARY_TEXT);
}

function joinWithinBudget(lines: string[], maxChars: number): string {
	if (lines.length === 0) return "";
	let result = "";

	for (const line of lines) {
		const next = result ? `${result}\n${line}` : line;
		if (next.length <= maxChars) {
			result = next;
			continue;
		}

		if (!result) {
			return trimText(line, maxChars);
		}

		const suffix = "\n...";
		if (result.length + suffix.length <= maxChars) {
			return `${result}${suffix}`;
		}
		if (maxChars <= 3) return ".".repeat(maxChars);
		return `${result.slice(0, maxChars - 3)}...`;
	}

	return result;
}

function getTopFiles(fileMatchCounts: Map<string, number>): FileMatchSummary[] {
	return [...fileMatchCounts.entries()]
		.map(([path, matchCount]) => ({ path, matchCount }))
		.sort((left, right) => right.matchCount - left.matchCount || left.path.localeCompare(right.path))
		.slice(0, MAX_TOP_FILES);
}

function buildResultText(
	result: SearchResult,
	params: {
		pattern: string;
		limit?: number;
	},
): string {
	const limit = Math.max(1, params.limit ?? DEFAULT_LIMIT);
	const lines: string[] = [];

	if (result.matchCount === 0) {
		lines.push(`No matches found for ${JSON.stringify(params.pattern)} in ${result.resolvedPath}`);
		if (result.stderr) lines.push(`stderr: ${trimLine(result.stderr)}`);
		return joinWithinBudget(lines, MAX_CONTENT_CHARS);
	}

	lines.push(
		`Found ${result.matchCount} ${result.matchCount === 1 ? "match" : "matches"} in ${result.fileCount} ${result.fileCount === 1 ? "file" : "files"} under ${result.resolvedPath}`,
	);

	if (result.topFiles.length > 0) {
		lines.push(`Top files: ${formatTopFiles(result.topFiles)}`);
	}

	const previewLines: string[] = [];
	for (const event of result.previewEvents) {
		const formattedEvent = formatEvent(event);
		const omittedCount = result.totalEventCount - (previewLines.length + 1);
		const footerLines: string[] = [];
		if (omittedCount > 0) {
			footerLines.push(
				`Showing ${previewLines.length + 1} preview ${(previewLines.length + 1) === 1 ? "line" : "lines"}; ${omittedCount} more ${omittedCount === 1 ? "event" : "events"} omitted.`,
			);
		}
		if (result.truncated) {
			footerLines.push(`Stopped after reaching the limit of ${limit} matches.`);
		}
		if (result.stderr) {
			footerLines.push(`stderr: ${trimLine(result.stderr)}`);
		}

		const candidateLines = [...lines, "Preview:", ...previewLines, formattedEvent, ...footerLines];
		if (candidateLines.join("\n").length > MAX_CONTENT_CHARS) break;
		previewLines.push(formattedEvent);
	}

	if (previewLines.length > 0) {
		lines.push("Preview:", ...previewLines);
	}

	const omittedCount = result.totalEventCount - previewLines.length;
	if (omittedCount > 0) {
		lines.push(
			`Showing ${previewLines.length} preview ${previewLines.length === 1 ? "line" : "lines"}; ${omittedCount} more ${omittedCount === 1 ? "event" : "events"} omitted.`,
		);
	}
	if (result.truncated) {
		lines.push(`Stopped after reaching the limit of ${limit} matches.`);
	}
	if (result.stderr) {
		lines.push(`stderr: ${trimLine(result.stderr)}`);
	}

	return joinWithinBudget(lines, MAX_CONTENT_CHARS);
}

function parseEvent(line: string): SearchEvent | null {
	const parsed = JSON.parse(line) as {
		type?: string;
		data?: {
			path?: TextOrBytes;
			line_number?: number;
			lines?: TextOrBytes;
			submatches?: Submatch[];
		};
	};

	if (parsed.type !== "match" && parsed.type !== "context") return null;
	const data = parsed.data ?? {};
	return {
		kind: parsed.type,
		path: decodeTextOrBytes(data.path) || "(unknown)",
		lineNumber: typeof data.line_number === "number" ? data.line_number : null,
		text: decodeTextOrBytes(data.lines),
		submatches: Array.isArray(data.submatches)
			? data.submatches.map((submatch) => ({
					text: decodeTextOrBytes(submatch.match),
					start: typeof submatch.start === "number" ? submatch.start : null,
					end: typeof submatch.end === "number" ? submatch.end : null,
				}))
			: [],
	};
}

function runRipgrep(
	cwd: string,
	params: {
		pattern: string;
		path?: string;
		glob?: string;
		ignoreCase?: boolean;
		literal?: boolean;
		context?: number;
		limit?: number;
	},
	signal?: AbortSignal,
): Promise<SearchResult> {
	return new Promise((resolvePromise, rejectPromise) => {
		const normalizedPath = normalizePathInput(params.path);
		const targetPath = normalizedPath ? resolve(cwd, normalizedPath) : cwd;
		const limit = Math.max(1, params.limit ?? DEFAULT_LIMIT);
		const args = ["--json", "--color", "never"];

		if (params.ignoreCase) args.push("-i");
		if (params.literal) args.push("-F");
		if (typeof params.context === "number" && params.context > 0) {
			args.push("-C", String(Math.floor(params.context)));
		}
		if (params.glob?.trim()) {
			args.push("-g", params.glob.trim());
		}

		args.push(params.pattern, targetPath);

		const child = spawn("rg", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const previewEvents: SearchEvent[] = [];
		const filesWithMatches = new Set<string>();
		const fileMatchCounts = new Map<string, number>();
		let matchCount = 0;
		let totalEventCount = 0;
		let truncated = false;
		let intentionallyStopped = false;
		let stdoutBuffer = "";
		let stderr = "";

		const stopChild = () => {
			if (intentionallyStopped) return;
			intentionallyStopped = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 250).unref();
		};

		const onAbort = () => {
			stopChild();
			rejectPromise(new Error("aborted"));
		};

		const handleEvent = (event: SearchEvent) => {
			if (truncated) return true;

			if (event.kind === "match") {
				matchCount += 1;
				filesWithMatches.add(event.path);
				fileMatchCounts.set(event.path, (fileMatchCounts.get(event.path) ?? 0) + 1);
			}

			totalEventCount += 1;
			if (previewEvents.length < DEFAULT_PREVIEW_EVENTS) {
				previewEvents.push(event);
			}

			if (matchCount >= limit) {
				truncated = true;
				stopChild();
				return true;
			}

			return false;
		};

		signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (error) => {
			signal?.removeEventListener("abort", onAbort);
			rejectPromise(error);
		});

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBuffer += chunk.toString("utf8");
			const lines = stdoutBuffer.split(/\r?\n/);
			stdoutBuffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = parseEvent(line);
					if (!event) continue;
					if (handleEvent(event)) break;
				} catch {
					// Ignore malformed JSON lines from ripgrep.
				}
			}
		});

		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) return;

			if (!truncated && stdoutBuffer.trim()) {
				try {
					const event = parseEvent(stdoutBuffer.trim());
					if (event) handleEvent(event);
				} catch {
					// Ignore trailing malformed JSON.
				}
			}

			if (code !== 0 && code !== 1 && !intentionallyStopped) {
				rejectPromise(new Error(stderr.trim() || `rg exited with code ${code}`));
				return;
			}

			resolvePromise({
				resolvedPath: targetPath,
				matchCount,
				fileCount: filesWithMatches.size,
				previewEvents,
				totalEventCount,
				topFiles: getTopFiles(fileMatchCounts),
				truncated,
				exitCode: code,
				stderr: stderr.trim(),
			});
		});
	});
}

export default function registerRipgrepTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "rg",
		label: "rg",
		description: "Search text with the system ripgrep binary from PATH and return structured results.",
		promptSnippet: "Search files with ripgrep using regex or literal matching.",
		promptGuidelines: [
			"Use this tool when the user explicitly asks for ripgrep or rg.",
			"Prefer this tool over raw bash when you want structured ripgrep results.",
		],
		parameters: Type.Object({
			pattern: Type.String({ description: "Pattern to search for." }),
			path: Type.Optional(
				Type.String({ description: "Directory or file to search. Relative paths resolve from the current working directory." }),
			),
			glob: Type.Optional(Type.String({ description: "Optional ripgrep glob filter, for example `*.ts`." })),
			ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search." })),
			literal: Type.Optional(Type.Boolean({ description: "Treat the pattern as a literal string instead of a regex." })),
			context: Type.Optional(Type.Integer({ minimum: 0, description: "Number of context lines to include around each match." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of matching lines to collect before stopping." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Running ripgrep..." }] });

			try {
				const result = await runRipgrep(ctx.cwd, params, signal);

				return {
					content: [{ type: "text", text: buildResultText(result, params) }],
					details: {
						pattern: params.pattern,
						path: result.resolvedPath,
						glob: params.glob,
						ignoreCase: !!params.ignoreCase,
						literal: !!params.literal,
						context: params.context ?? 0,
						limit: Math.max(1, params.limit ?? DEFAULT_LIMIT),
						matchCount: result.matchCount,
						fileCount: result.fileCount,
						totalEventCount: result.totalEventCount,
						previewEventCount: result.previewEvents.length,
						topFiles: result.topFiles,
						truncated: result.truncated,
						exitCode: result.exitCode,
						events: result.previewEvents,
						stderr: result.stderr,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					message.includes("ENOENT")
						? "The `rg` binary was not found on PATH. Install ripgrep or make sure Pi can see it in your shell environment."
						: message,
				);
			}
		},
	});
}
