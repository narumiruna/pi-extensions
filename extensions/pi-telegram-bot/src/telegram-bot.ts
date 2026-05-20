import { existsSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const STATUS_KEY = "telegram";
const POLL_TIMEOUT_SECONDS = 30;
const POLL_LIMIT = 100;
const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_CHUNK_LIMIT = 3900;
const CONFIG_FILE_NAME = "telegram.json";
const REMOTE_TURN_START_TIMEOUT_MS = 30_000;

interface TelegramConfig {
	token: string;
	chatId?: string;
	source: string;
}

type ConfigResult = { ok: true; value: TelegramConfig } | { ok: false; error: string };

type TelegramApiResponse<T> =
	| { ok: true; result: T }
	| {
			ok: false;
			description?: string;
			error_code?: number;
			parameters?: { retry_after?: number };
	  };

interface TelegramUser {
	id: number;
	is_bot?: boolean;
	first_name?: string;
	last_name?: string;
	username?: string;
}

interface TelegramChat {
	id: number | string;
	type?: string;
	title?: string;
	username?: string;
	first_name?: string;
	last_name?: string;
}

interface TelegramMessage {
	message_id: number;
	date?: number;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
}

interface TelegramSentMessage {
	message_id: number;
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
}

interface RemoteTurn {
	id: string;
	marker: string;
	prompt: string;
	chatId: string;
	messageId: number;
	statusMessageId?: number;
	state: "queued" | "active";
	createdAt: number;
}

interface Poller {
	stop(): void;
	isRunning(): boolean;
}

class TelegramApiError extends Error {
	readonly retryAfterMs?: number;

	constructor(message: string, retryAfterSeconds?: number) {
		super(message);
		this.name = "TelegramApiError";
		this.retryAfterMs = retryAfterSeconds ? retryAfterSeconds * 1000 : undefined;
	}
}

class TelegramClient {
	private readonly token: string;

	constructor(token: string) {
		this.token = token;
	}

	async getMe(signal?: AbortSignal): Promise<TelegramUser> {
		return this.request<TelegramUser>("getMe", {}, signal);
	}

	async getUpdates(
		params: {
			offset?: number;
			timeout?: number;
			limit?: number;
			allowed_updates?: string[];
		},
		signal?: AbortSignal,
	): Promise<TelegramUpdate[]> {
		return this.request<TelegramUpdate[]>("getUpdates", params, signal);
	}

	async sendMessage(
		params: {
			chat_id: string;
			text: string;
			reply_to_message_id?: number;
			disable_web_page_preview?: boolean;
		},
		signal?: AbortSignal,
	): Promise<TelegramSentMessage> {
		return this.request<TelegramSentMessage>("sendMessage", params, signal);
	}

	async editMessageText(
		params: {
			chat_id: string;
			message_id: number;
			text: string;
			disable_web_page_preview?: boolean;
		},
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.request("editMessageText", params, signal);
	}

	private async request<T>(
		method: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<T> {
		const response = await fetch(`${TELEGRAM_API_BASE}/bot${this.token}/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
			signal,
		});

		const responseText = await response.text();
		const payload = parseTelegramResponse<T>(responseText, method);

		if (!response.ok) {
			const description = payload.ok ? responseText : (payload.description ?? responseText);
			throw new TelegramApiError(
				`Telegram ${method} returned ${response.status} ${response.statusText}: ${description}`,
				payload.ok ? undefined : payload.parameters?.retry_after,
			);
		}

		if (!payload.ok) {
			throw new TelegramApiError(
				`Telegram ${method} failed: ${payload.description ?? "unknown error"}`,
				payload.parameters?.retry_after,
			);
		}

		return payload.result;
	}
}

export default function telegram(pi: ExtensionAPI) {
	let poller: Poller | undefined;
	let currentConfig: TelegramConfig | undefined;
	let currentBotUsername: string | undefined;
	let telegramEnabled = false;
	let agentRunning = false;
	let remoteSubmissionPending = false;
	let pollGeneration = 0;
	let remoteTurns: RemoteTurn[] = [];
	let pendingSteers: RemoteTurn[] = [];
	let nextRemoteTurnId = 1;

	const stopPolling = () => {
		pollGeneration++;
		poller?.stop();
		poller = undefined;
		currentBotUsername = undefined;
	};

	const disableTelegram = () => {
		telegramEnabled = false;
		stopPolling();
		remoteTurns = [];
		pendingSteers = [];
		remoteSubmissionPending = false;
		currentConfig = undefined;
	};

	const getActiveConfig = (): ConfigResult => {
		if (currentConfig) return { ok: true, value: currentConfig };
		return readConfig();
	};

	const isTelegramActive = (generation?: number) => {
		return (
			telegramEnabled &&
			Boolean(currentConfig) &&
			(generation === undefined || generation === pollGeneration)
		);
	};

	const markRemoteTurnActive = (text: string) => {
		for (const turn of remoteTurns) {
			if (turn.state === "queued" && text.includes(turn.marker)) turn.state = "active";
		}
	};

	const getConfiguredClient = () => {
		const config = getActiveConfig();
		if (!config.ok) throw new Error(config.error);

		if (!config.value.chatId) {
			throw new Error(
				"Telegram chatId is not configured yet. Send /whoami to the bot and add the Chat ID to telegram.json.",
			);
		}

		return {
			chatId: config.value.chatId,
			client: new TelegramClient(config.value.token),
		};
	};

	const sendSessionMessage = async (
		ctx: ExtensionContext,
		text: string,
		options: { replyToMessageId?: number; includeHeader?: boolean } = {},
	) => {
		const { chatId, client } = getConfiguredClient();
		const body = options.includeHeader === true ? withSessionHeader(pi, ctx, text) : text;
		const chunks = splitTelegramMessage(body);
		const sentMessages: TelegramSentMessage[] = [];
		for (let index = 0; index < chunks.length; index++) {
			const prefix = index === 0 ? "" : "(continued)\n";
			sentMessages.push(
				await client.sendMessage({
					chat_id: chatId,
					text: `${prefix}${chunks[index]}`,
					reply_to_message_id: index === 0 ? options.replyToMessageId : undefined,
					disable_web_page_preview: true,
				}),
			);
		}
		return sentMessages;
	};

	const editSessionMessage = async (
		ctx: ExtensionContext,
		messageId: number,
		text: string,
		options: { replyToMessageId?: number; includeHeader?: boolean } = {},
	) => {
		const { chatId, client } = getConfiguredClient();
		const body = options.includeHeader === true ? withSessionHeader(pi, ctx, text) : text;
		const chunks = splitTelegramMessage(body);
		const [firstChunk, ...remainingChunks] = chunks;
		await client.editMessageText({
			chat_id: chatId,
			message_id: messageId,
			text: firstChunk ?? "",
			disable_web_page_preview: true,
		});
		for (const chunk of remainingChunks) {
			await client.sendMessage({
				chat_id: chatId,
				text: `(continued)\n${chunk}`,
				reply_to_message_id: options.replyToMessageId,
				disable_web_page_preview: true,
			});
		}
	};

	const sendDirectTelegramMessage = async (
		chatId: string,
		text: string,
		options: { replyToMessageId?: number } = {},
	) => {
		const config = currentConfig;
		if (!config) return;
		const client = new TelegramClient(config.token);
		const chunks = splitTelegramMessage(text);
		for (let index = 0; index < chunks.length; index++) {
			await client.sendMessage({
				chat_id: chatId,
				text: chunks[index],
				reply_to_message_id: index === 0 ? options.replyToMessageId : undefined,
				disable_web_page_preview: true,
			});
		}
	};

	const enableTelegram = (ctx: ExtensionContext): ConfigResult => {
		const config = readConfig();
		if (!config.ok) {
			disableTelegram();
			return config;
		}

		stopPolling();
		telegramEnabled = true;
		remoteTurns = [];
		pendingSteers = [];
		remoteSubmissionPending = false;
		currentConfig = config.value;
		const generation = pollGeneration;
		poller = startTelegramPolling(config.value, ctx, {
			isActive: () => isTelegramActive(generation),
			onBotInfo: (bot) => {
				currentBotUsername = bot.username;
			},
			onMessage: (message, text) => handleTelegramTextMessage(message, text, ctx, generation),
			onError: (error) => {
				if (ctx.hasUI)
					ctx.ui.notify(`pi-telegram-bot polling error: ${errorMessage(error)}`, "warning");
			},
		});

		return config;
	};

	const showTelegramCommandMenu = async (ctx: ExtensionContext) => {
		const enabled = poller?.isRunning() ?? false;
		const toggleLabel = enabled ? "Disable pi-telegram-bot" : "Enable pi-telegram-bot";
		const choice = await ctx.ui.select("pi-telegram-bot", [toggleLabel, "Show status", "Help"]);
		if (!choice) return;

		if (choice === toggleLabel) {
			if (enabled) {
				disableTelegram();
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("pi-telegram-bot disabled.", "info");
				return;
			}

			const config = enableTelegram(ctx);
			ctx.ui.notify(
				config.ok
					? `pi-telegram-bot enabled. Configuration: ${compactPath(config.value.source)}`
					: `Failed to enable pi-telegram-bot: ${config.error}`,
				config.ok ? "info" : "error",
			);
			return;
		}

		if (choice === "Show status") {
			ctx.ui.notify(buildLocalStatus(pi, ctx, getActiveConfig(), enabled), "info");
			return;
		}

		if (choice === "Help") ctx.ui.notify(buildPiCommandHelp(), "info");
	};

	const validateAgentReady = (ctx: ExtensionContext): string | undefined => {
		if (!ctx.model)
			return "Pi has no model selected. Select a model locally before using Telegram.";
		if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
			return `Pi has no configured auth for ${ctx.model.provider}. Configure auth locally before using Telegram.`;
		}
		return undefined;
	};

	const sendRemoteTurnText = async (ctx: ExtensionContext, turn: RemoteTurn, text: string) => {
		if (turn.statusMessageId) {
			try {
				await editSessionMessage(ctx, turn.statusMessageId, text, {
					replyToMessageId: turn.messageId,
				});
				return;
			} catch {
				// Fall back to a new reply when Telegram refuses to edit the temporary status message.
			}
		}
		await sendSessionMessage(ctx, text, { replyToMessageId: turn.messageId });
	};

	const failRemoteTurn = async (ctx: ExtensionContext, turn: RemoteTurn, text: string) => {
		remoteTurns = remoteTurns.filter((candidate) => candidate.id !== turn.id);
		pendingSteers = pendingSteers.filter((candidate) => candidate.id !== turn.id);
		await sendRemoteTurnText(ctx, turn, text);
	};

	const scheduleRemoteTurnStartTimeout = (ctx: ExtensionContext, turn: RemoteTurn) => {
		setTimeout(() => {
			if (!remoteSubmissionPending || turn.state !== "queued") return;
			if (!remoteTurns.some((candidate) => candidate.id === turn.id)) return;
			remoteSubmissionPending = false;
			void failRemoteTurn(
				ctx,
				turn,
				"Pi did not start processing this Telegram message. Check the local session and try again.",
			)
				.then(() => {
					schedulePromoteQueuedBusyTurns(ctx);
				})
				.catch((error) => {
					if (ctx.hasUI)
						ctx.ui.notify(
							`Failed to send Telegram timeout notice: ${errorMessage(error)}`,
							"error",
						);
				});
		}, REMOTE_TURN_START_TIMEOUT_MS);
	};

	const promoteNextPendingTurn = (ctx: ExtensionContext): boolean => {
		if (agentRunning || remoteSubmissionPending || !ctx.isIdle()) return false;

		while (pendingSteers.length > 0) {
			const turn = pendingSteers.shift();
			if (!turn) return false;
			if (!remoteTurns.some((candidate) => candidate.id === turn.id)) continue;
			if (turn.state !== "queued") continue;

			try {
				remoteSubmissionPending = true;
				pi.sendUserMessage(turn.prompt);
				scheduleRemoteTurnStartTimeout(ctx, turn);
				return true;
			} catch (error) {
				remoteSubmissionPending = false;
				void failRemoteTurn(
					ctx,
					turn,
					`Failed to send Telegram message to Pi: ${errorMessage(error)}`,
				).catch((noticeError) => {
					if (ctx.hasUI)
						ctx.ui.notify(
							`Failed to send Telegram failure notice: ${errorMessage(noticeError)}`,
							"error",
						);
				});
			}
		}

		return false;
	};

	const promoteQueuedBusyTurns = (ctx: ExtensionContext): boolean => {
		for (const turn of remoteTurns) {
			if (turn.state !== "queued" || !turn.statusMessageId) continue;
			if (pendingSteers.some((candidate) => candidate.id === turn.id)) continue;
			pendingSteers.push(turn);
		}
		return promoteNextPendingTurn(ctx);
	};

	const schedulePromoteQueuedBusyTurns = (ctx: ExtensionContext, attempt = 0) => {
		setTimeout(() => {
			if (!isTelegramActive()) return;
			if (promoteQueuedBusyTurns(ctx)) return;
			const hasQueuedBusyTurns = remoteTurns.some(
				(turn) => turn.state === "queued" && Boolean(turn.statusMessageId),
			);
			const shouldRetry = hasQueuedBusyTurns || pendingSteers.length > 0;
			if (shouldRetry && !agentRunning && !remoteSubmissionPending && attempt < 20) {
				schedulePromoteQueuedBusyTurns(ctx, attempt + 1);
			}
		}, 50);
	};

	const flushPendingSteers = (ctx: ExtensionContext) => {
		const turns = pendingSteers;
		pendingSteers = [];
		for (const turn of turns) {
			if (!remoteTurns.some((candidate) => candidate.id === turn.id)) continue;
			if (turn.state !== "queued") continue;
			try {
				pi.sendUserMessage(turn.prompt, { deliverAs: "steer" });
			} catch (error) {
				void failRemoteTurn(
					ctx,
					turn,
					`Failed to send Telegram message to Pi: ${errorMessage(error)}`,
				).catch((noticeError) => {
					if (ctx.hasUI)
						ctx.ui.notify(
							`Failed to send Telegram failure notice: ${errorMessage(noticeError)}`,
							"error",
						);
				});
			}
		}
	};

	const handleTelegramTextMessage = async (
		message: TelegramMessage,
		text: string,
		ctx: ExtensionContext,
		generation: number,
	) => {
		if (!isTelegramActive(generation) || !currentConfig) return;
		const config = currentConfig;
		const chatId = normalizeChatId(message.chat.id);
		const parsedCommand = parseTelegramCommand(text, currentBotUsername);

		if (!config.chatId) {
			await handleSetupTelegramMessage(parsedCommand, message, sendDirectTelegramMessage);
			return;
		}

		if (chatId !== config.chatId) return;

		if (parsedCommand) {
			await handleTelegramCommand(parsedCommand, message, ctx, { sendSessionMessage });
			return;
		}

		const readinessError = validateAgentReady(ctx);
		if (readinessError) {
			await sendSessionMessage(ctx, readinessError, { replyToMessageId: message.message_id });
			return;
		}
		if (!isTelegramActive(generation)) return;

		const remoteTurnId = `${Date.now()}-${nextRemoteTurnId++}`;
		const marker = `pi-telegram-bot:${remoteTurnId}`;
		const prompt = buildRemotePrompt(marker, message, text);
		const remoteTurn: RemoteTurn = {
			id: remoteTurnId,
			marker,
			prompt,
			chatId,
			messageId: message.message_id,
			state: "queued",
			createdAt: Date.now(),
		};
		remoteTurns.push(remoteTurn);
		if (!isTelegramActive(generation)) {
			remoteTurns = remoteTurns.filter((turn) => turn.id !== remoteTurnId);
			return;
		}

		try {
			const shouldStartTurn = !agentRunning && !remoteSubmissionPending && ctx.isIdle();
			if (shouldStartTurn) {
				remoteSubmissionPending = true;
				pi.sendUserMessage(prompt);
				scheduleRemoteTurnStartTimeout(ctx, remoteTurn);
			} else {
				const sentMessages = await sendSessionMessage(
					ctx,
					"Agent is busy; your Telegram message will steer the current turn.",
					{
						replyToMessageId: message.message_id,
					},
				);
				remoteTurn.statusMessageId = sentMessages[0]?.message_id;
				if (!isTelegramActive(generation)) {
					remoteTurns = remoteTurns.filter((turn) => turn.id !== remoteTurnId);
					return;
				}
				if (agentRunning || !ctx.isIdle()) {
					pi.sendUserMessage(prompt, { deliverAs: "steer" });
				} else {
					pendingSteers.push(remoteTurn);
					promoteNextPendingTurn(ctx);
				}
			}
		} catch (error) {
			remoteSubmissionPending = false;
			remoteTurns = remoteTurns.filter((turn) => turn.id !== remoteTurnId);
			pendingSteers = pendingSteers.filter((turn) => turn.id !== remoteTurnId);
			await sendSessionMessage(
				ctx,
				`Failed to send Telegram message to Pi: ${errorMessage(error)}`,
				{
					replyToMessageId: message.message_id,
				},
			);
		}
	};

	pi.registerCommand("telegram-bot", {
		description: "Enable, disable, or inspect the pi-telegram-bot bridge",
		handler: async (args, ctx) => {
			const parsed = parsePiTelegramArgs(args);
			if (parsed.command === "menu") {
				await showTelegramCommandMenu(ctx);
				return;
			}

			if (["enable", "on", "start"].includes(parsed.command)) {
				const config = enableTelegram(ctx);
				ctx.ui.notify(
					config.ok
						? `pi-telegram-bot enabled. Configuration: ${compactPath(config.value.source)}`
						: `Failed to enable pi-telegram-bot: ${config.error}`,
					config.ok ? "info" : "error",
				);
				return;
			}

			if (["disable", "off", "stop"].includes(parsed.command)) {
				disableTelegram();
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("pi-telegram-bot disabled.", "info");
				return;
			}

			if (parsed.command === "send") {
				if (!parsed.text) {
					ctx.ui.notify("Usage: /telegram-bot send <text>", "warning");
					return;
				}
				try {
					await sendSessionMessage(ctx, parsed.text);
					ctx.ui.notify("Sent Telegram message.", "info");
				} catch (error) {
					ctx.ui.notify(`Failed to send Telegram message: ${errorMessage(error)}`, "error");
				}
				return;
			}

			if (parsed.command === "help") {
				ctx.ui.notify(buildPiCommandHelp(), "info");
				return;
			}

			if (parsed.command !== "status") {
				ctx.ui.notify(
					`Unknown /telegram-bot command: ${parsed.command}. ${buildPiCommandUsage()}`,
					"warning",
				);
				return;
			}

			ctx.ui.notify(
				buildLocalStatus(pi, ctx, getActiveConfig(), poller?.isRunning() ?? false),
				"info",
			);
		},
	});

	pi.on("session_start", () => {
		agentRunning = false;
		disableTelegram();
	});

	pi.on("before_agent_start", (event) => {
		markRemoteTurnActive(event.prompt);
	});

	pi.on("agent_start", (_event, ctx) => {
		agentRunning = true;
		remoteSubmissionPending = false;
		flushPendingSteers(ctx);
	});

	pi.on("message_start", (event) => {
		if (!isRecord(event.message) || event.message.role !== "user") return;
		markRemoteTurnActive(extractTextContent(event.message.content));
	});

	pi.on("agent_end", async (event, ctx) => {
		agentRunning = false;
		remoteSubmissionPending = false;
		const turns = remoteTurns.filter((candidate) => candidate.state === "active");
		if (turns.length === 0) {
			schedulePromoteQueuedBusyTurns(ctx);
			return;
		}

		remoteTurns = remoteTurns.filter((candidate) => candidate.state !== "active");
		const finalText =
			extractLastAssistantText(event.messages) || "Agent finished without a text response.";
		for (const turn of turns) {
			try {
				if (turn.statusMessageId) {
					await editSessionMessage(ctx, turn.statusMessageId, finalText, {
						replyToMessageId: turn.messageId,
					});
					continue;
				}
				await sendSessionMessage(ctx, finalText, { replyToMessageId: turn.messageId });
			} catch (error) {
				if (turn.statusMessageId) {
					try {
						await sendSessionMessage(ctx, finalText, { replyToMessageId: turn.messageId });
					} catch {
						// Keep the original edit error for the local notification below.
					}
				}
				if (ctx.hasUI)
					ctx.ui.notify(`Failed to send Telegram reply: ${errorMessage(error)}`, "error");
			}
		}
		schedulePromoteQueuedBusyTurns(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		telegramEnabled = false;
		agentRunning = false;
		remoteSubmissionPending = false;
		stopPolling();
		remoteTurns = [];
		pendingSteers = [];
		currentConfig = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

function startTelegramPolling(
	config: TelegramConfig,
	ctx: ExtensionContext,
	callbacks: {
		isActive: () => boolean;
		onBotInfo: (bot: TelegramUser) => void;
		onMessage: (message: TelegramMessage, text: string) => Promise<void>;
		onError: (error: unknown) => void;
	},
): Poller {
	const controller = new AbortController();
	let running = true;
	void pollTelegram(config, ctx, callbacks, controller.signal).finally(() => {
		running = false;
		if (callbacks.isActive()) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	return {
		stop() {
			controller.abort();
		},
		isRunning() {
			return running && !controller.signal.aborted && callbacks.isActive();
		},
	};
}

async function pollTelegram(
	config: TelegramConfig,
	ctx: ExtensionContext,
	callbacks: {
		isActive: () => boolean;
		onBotInfo: (bot: TelegramUser) => void;
		onMessage: (message: TelegramMessage, text: string) => Promise<void>;
		onError: (error: unknown) => void;
	},
	signal: AbortSignal,
) {
	const client = new TelegramClient(config.token);
	let offset: number | undefined;
	let retryMs = INITIAL_RETRY_MS;
	let notifiedError = false;

	while (!signal.aborted && callbacks.isActive()) {
		try {
			ctx.ui.setStatus(STATUS_KEY, "📨 connecting");
			const bot = await client.getMe(signal);
			if (!callbacks.isActive()) return;
			callbacks.onBotInfo(bot);
			offset = await discardPendingUpdates(client, signal);
			if (!callbacks.isActive()) return;
			ctx.ui.setStatus(STATUS_KEY, undefined);
			break;
		} catch (error) {
			if (isAbortError(error) || signal.aborted || !callbacks.isActive()) return;
			const transientNetworkError = isTransientNetworkError(error);
			ctx.ui.setStatus(STATUS_KEY, transientNetworkError ? "📨 retrying" : "📨 error");
			if (!transientNetworkError && !notifiedError) {
				callbacks.onError(error);
				notifiedError = true;
			}
			await delay(retryDelay(error, retryMs), signal);
			retryMs = nextRetryMs(retryMs);
		}
	}

	retryMs = INITIAL_RETRY_MS;
	notifiedError = false;
	while (!signal.aborted && callbacks.isActive()) {
		try {
			const updates = await client.getUpdates(
				{
					offset,
					timeout: POLL_TIMEOUT_SECONDS,
					limit: POLL_LIMIT,
					allowed_updates: ["message"],
				},
				signal,
			);
			if (!callbacks.isActive()) return;
			retryMs = INITIAL_RETRY_MS;
			notifiedError = false;
			ctx.ui.setStatus(STATUS_KEY, undefined);

			for (const update of updates) {
				if (signal.aborted || !callbacks.isActive()) return;
				offset = update.update_id + 1;
				const message = update.message;
				const text = message?.text?.trim();
				if (!message || !text) continue;
				await callbacks.onMessage(message, text);
			}
		} catch (error) {
			if (isAbortError(error) || signal.aborted || !callbacks.isActive()) return;
			const transientNetworkError = isTransientNetworkError(error);
			ctx.ui.setStatus(STATUS_KEY, transientNetworkError ? "📨 retrying" : "📨 error");
			if (!transientNetworkError && !notifiedError) {
				callbacks.onError(error);
				notifiedError = true;
			}
			await delay(retryDelay(error, retryMs), signal);
			retryMs = nextRetryMs(retryMs);
		}
	}
}

async function discardPendingUpdates(
	client: TelegramClient,
	signal: AbortSignal,
): Promise<number | undefined> {
	let nextOffset: number | undefined;

	while (!signal.aborted) {
		const updates = await client.getUpdates(
			{ offset: nextOffset, timeout: 0, limit: POLL_LIMIT, allowed_updates: [] },
			signal,
		);
		if (updates.length === 0) return nextOffset;
		const maxUpdateId = Math.max(...updates.map((update) => update.update_id));
		nextOffset = maxUpdateId + 1;
		if (updates.length < POLL_LIMIT) return nextOffset;
	}

	return nextOffset;
}

async function handleSetupTelegramMessage(
	command: { name: string; args: string } | undefined,
	message: TelegramMessage,
	sendDirectTelegramMessage: (
		chatId: string,
		text: string,
		options?: { replyToMessageId?: number },
	) => Promise<void>,
) {
	if (!command || !["start", "help", "whoami"].includes(command.name)) return;

	const chatId = normalizeChatId(message.chat.id);
	const text = command.name === "whoami" ? buildWhoami(message) : buildTelegramSetupHelp(message);
	await sendDirectTelegramMessage(chatId, text, { replyToMessageId: message.message_id });
}

async function handleTelegramCommand(
	command: { name: string; args: string },
	message: TelegramMessage,
	ctx: ExtensionContext,
	handlers: {
		sendSessionMessage: (
			ctx: ExtensionContext,
			text: string,
			options?: { replyToMessageId?: number; includeHeader?: boolean },
		) => Promise<unknown>;
	},
) {
	const { sendSessionMessage } = handlers;
	switch (command.name) {
		case "start":
		case "help":
			await sendSessionMessage(ctx, buildTelegramHelp(), { replyToMessageId: message.message_id });
			return;
		case "status":
			await sendSessionMessage(ctx, "Pi session is reachable from Telegram.", {
				replyToMessageId: message.message_id,
				includeHeader: true,
			});
			return;
		case "whoami":
			await sendSessionMessage(ctx, buildWhoami(message), { replyToMessageId: message.message_id });
			return;
		case "cancel":
			if (ctx.isIdle()) {
				await sendSessionMessage(ctx, "Pi agent is already idle.", {
					replyToMessageId: message.message_id,
				});
				return;
			}
			ctx.abort();
			await sendSessionMessage(ctx, "Abort requested for the current Pi agent turn.", {
				replyToMessageId: message.message_id,
			});
			return;
		default:
			await sendSessionMessage(ctx, `Unknown command: /${command.name}\n\n${buildTelegramHelp()}`, {
				replyToMessageId: message.message_id,
			});
	}
}

function readConfig(): ConfigResult {
	try {
		const userConfig = userConfigPath();
		if (existsSync(userConfig)) return { ok: true, value: parseConfigFile(userConfig) };

		return {
			ok: false,
			error: `No Telegram config found. Create ${compactPath(userConfig)}.`,
		};
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

function parseConfigFile(filePath: string): TelegramConfig {
	assertPrivateConfigFile(filePath);
	return normalizeConfig(JSON.parse(readFileSync(filePath, "utf8")), filePath);
}

function assertPrivateConfigFile(filePath: string) {
	if (process.platform === "win32") return;

	const stat = statSync(filePath);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error(`${compactPath(filePath)} must be owned by the current user.`);
	}
	if ((stat.mode & 0o077) !== 0) {
		throw new Error(
			`${compactPath(filePath)} must not be readable by group or others. Run: chmod 600 ${compactPath(filePath)}`,
		);
	}
}

function normalizeConfig(value: unknown, source: string): TelegramConfig {
	if (!isRecord(value)) throw new Error(`${source} must be a JSON object.`);

	const token = firstStringField(value, ["botToken", "token", "telegramBotToken"], source);
	const chatId = firstOptionalStringOrNumberField(
		value,
		["chatId", "chat_id", "telegramChatId"],
		source,
	);

	if (!token.trim()) throw new Error(`${source}.botToken must not be blank.`);
	const normalizedChatId = chatId?.trim();

	return { token: token.trim(), chatId: normalizedChatId || undefined, source };
}

function userConfigPath(): string {
	return path.join(getAgentDir(), CONFIG_FILE_NAME);
}

function firstStringField(
	value: Record<string, unknown>,
	fields: string[],
	source: string,
): string {
	for (const field of fields) {
		const fieldValue = value[field];
		if (typeof fieldValue === "string") return fieldValue;
	}
	throw new Error(`${source}.${fields[0]} must be a string.`);
}

function firstOptionalStringOrNumberField(
	value: Record<string, unknown>,
	fields: string[],
	source: string,
): string | undefined {
	for (const field of fields) {
		const fieldValue = value[field];
		if (fieldValue === undefined) continue;
		if (typeof fieldValue === "string") return fieldValue;
		if (typeof fieldValue === "number" && Number.isFinite(fieldValue)) return String(fieldValue);
		throw new Error(`${source}.${field} must be a string or number.`);
	}
	return undefined;
}

function parseTelegramResponse<T>(responseText: string, method: string): TelegramApiResponse<T> {
	try {
		return JSON.parse(responseText) as TelegramApiResponse<T>;
	} catch {
		return { ok: false, description: `Telegram ${method} returned non-JSON response.` };
	}
}

function parseTelegramCommand(
	text: string,
	botUsername: string | undefined,
): { name: string; args: string } | undefined {
	if (!text.startsWith("/")) return undefined;
	const [rawCommand, ...rest] = text.slice(1).split(/\s+/);
	if (!rawCommand) return undefined;

	const [name, targetUsername] = rawCommand.split("@", 2);
	if (targetUsername && botUsername && targetUsername.toLowerCase() !== botUsername.toLowerCase()) {
		return undefined;
	}

	return { name: name.toLowerCase(), args: rest.join(" ").trim() };
}

function parsePiTelegramArgs(args: string): {
	command: "menu" | "status" | "help" | "send" | string;
	text: string;
} {
	const trimmed = args.trim();
	if (!trimmed) return { command: "menu", text: "" };
	const [command, ...rest] = trimmed.split(/\s+/);
	return { command: command.toLowerCase(), text: rest.join(" ").trim() };
}

function buildRemotePrompt(marker: string, message: TelegramMessage, text: string): string {
	return [
		`[Telegram remote message: ${marker}]`,
		`From: ${formatTelegramUser(message.from)}`,
		`Chat: ${formatTelegramChat(message.chat)}`,
		"",
		text,
	].join("\n");
}

function withSessionHeader(pi: ExtensionAPI, ctx: ExtensionContext, text: string): string {
	return `${buildSessionHeader(pi, ctx)}\n\n${text}`;
}

function buildSessionHeader(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const sessionName = pi.getSessionName() || "(unnamed)";
	const sessionFile = ctx.sessionManager.getSessionFile();
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(no model selected)";

	return [
		"🤖 Pi Telegram session",
		`Name: ${sessionName}`,
		`Session: ${sessionFile ? compactPath(sessionFile) : "ephemeral"}`,
		`Project: ${compactPath(ctx.cwd)}`,
		`Model: ${model}`,
	].join("\n");
}

function buildLocalStatus(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: ConfigResult,
	polling: boolean,
): string {
	const lines = [
		"pi-telegram-bot status",
		"",
		config.ok
			? `Configuration: ${compactPath(config.value.source)}`
			: `Configuration: ${config.error}`,
		config.ok ? "Telegram bot token: set" : "Telegram bot token: unavailable",
		config.ok
			? `Telegram chat id: ${config.value.chatId ?? "not set (setup mode: send /whoami to the bot)"}`
			: "Telegram chat id: unavailable",
		`Polling: ${polling ? "running" : "disabled (run /telegram-bot enable to start)"}`,
		"Custom tools: none",
		"",
		buildSessionHeader(pi, ctx),
	];
	return lines.join("\n");
}

function buildPiCommandHelp(): string {
	return [
		buildPiCommandUsage(),
		"",
		"With no arguments, /telegram-bot opens an enable/disable menu. Polling is disabled by default for each Pi session.",
		"This extension registers no custom tools. Telegram messages are sent to the current Pi session with pi.sendUserMessage().",
	].join("\n");
}

function buildPiCommandUsage(): string {
	return "Usage: /telegram-bot [enable|disable|status|help] or /telegram-bot send <text>. Telegram users can use /help, /status, /whoami, and /cancel.";
}

function buildTelegramSetupHelp(message: TelegramMessage): string {
	return [
		"pi-telegram-bot setup mode: chatId is not configured yet.",
		"",
		buildWhoami(message),
		"",
		`Add this value to ~/.pi/agent/${CONFIG_FILE_NAME}:`,
		"",
		`  "chatId": "${normalizeChatId(message.chat.id)}"`,
		"",
		"Until chatId is configured, only /start, /help, and /whoami are answered and no messages are forwarded to Pi.",
	].join("\n");
}

function buildTelegramHelp(): string {
	return [
		"Send any normal text message to talk to this Pi session.",
		"",
		"Commands:",
		"/start - show this help",
		"/help - show this help",
		"/status - show the current Pi session identity",
		"/whoami - show Telegram chat and user identity",
		"/cancel - request abort for the current Pi turn",
		"",
		"Code changes are possible when the current Pi session has write/edit/bash tools active.",
	].join("\n");
}

function buildWhoami(message: TelegramMessage): string {
	return [
		"Telegram identity:",
		`Chat: ${formatTelegramChat(message.chat)}`,
		`Chat ID: ${normalizeChatId(message.chat.id)}`,
		`User: ${formatTelegramUser(message.from)}`,
		message.from ? `User ID: ${message.from.id}` : undefined,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

function extractLastAssistantText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "assistant") continue;
		const text = extractTextContent(message.content);
		if (text) return text;
	}
	return "";
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (!isRecord(part) || part.type !== "text") return "";
			return typeof part.text === "string" ? part.text.trim() : "";
		})
		.filter(Boolean)
		.join("\n\n")
		.trim();
}

function splitTelegramMessage(message: string): string[] {
	if (message.length <= TELEGRAM_MESSAGE_LIMIT) return [message];

	const chunks: string[] = [];
	let remaining = message;
	while (remaining.length > 0) {
		if (remaining.length <= TELEGRAM_CHUNK_LIMIT) {
			chunks.push(remaining);
			break;
		}

		let splitAt = remaining.lastIndexOf("\n", TELEGRAM_CHUNK_LIMIT);
		if (splitAt < TELEGRAM_CHUNK_LIMIT / 2) splitAt = TELEGRAM_CHUNK_LIMIT;
		chunks.push(remaining.slice(0, splitAt).trimEnd());
		remaining = remaining.slice(splitAt).trimStart();
	}

	return chunks;
}

function retryDelay(error: unknown, fallbackMs: number): number {
	return error instanceof TelegramApiError && error.retryAfterMs ? error.retryAfterMs : fallbackMs;
}

function nextRetryMs(currentMs: number): number {
	return Math.min(currentMs * 2, MAX_RETRY_MS);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}

		let timeout: ReturnType<typeof setTimeout>;
		const abort = () => {
			clearTimeout(timeout);
			resolve();
		};
		timeout = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal.addEventListener("abort", abort, { once: true });
	});
}

function normalizeChatId(chatId: string | number): string {
	return String(chatId);
}

function formatTelegramChat(chat: TelegramChat): string {
	const title = chat.title ?? chat.username ?? chat.first_name ?? "chat";
	return `${title} (${normalizeChatId(chat.id)})`;
}

function formatTelegramUser(user: TelegramUser | undefined): string {
	if (!user) return "unknown";
	const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
	const username = user.username ? `@${user.username}` : undefined;
	return [displayName || undefined, username, `(${user.id})`].filter(Boolean).join(" ");
}

function compactPath(value: string): string {
	const home = os.homedir();
	const normalized = path.normalize(value);
	return normalized === home || normalized.startsWith(`${home}${path.sep}`)
		? `~${normalized.slice(home.length)}`
		: normalized;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function isTransientNetworkError(error: unknown): boolean {
	return error instanceof TypeError && error.message.toLowerCase().includes("fetch failed");
}

function errorMessage(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = error.cause;
	if (cause instanceof Error && cause.message && cause.message !== error.message) {
		return `${error.message}: ${cause.message}`;
	}
	if (typeof cause === "string" && cause && cause !== error.message) {
		return `${error.message}: ${cause}`;
	}
	return error.message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
