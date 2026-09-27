import { DurableObject } from "cloudflare:workers";

export class MyDurableObject extends DurableObject<Env> {
	private sockets = new Map<WebSocket, string>();
	private turnPlayer = "player1";

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("WebSocket room", { status: 200 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		if (this.sockets.size >= 2) {
			server.accept();
			server.send(JSON.stringify({
				type: "error",
				message: "Room is full",
			}));
			server.close(1008, "Room is full");

			return new Response(null, {
				status: 101,
				webSocket: client,
			});
		}

		server.accept();

		const usedPlayerIds = new Set(this.sockets.values());
		const playerId = usedPlayerIds.has("player1") ? "player2" : "player1";

		this.sockets.set(server, playerId);

		server.send(JSON.stringify({
			type: "joined",
			playerId,
			turnPlayer: this.turnPlayer,
		}));

		for (const [socket] of this.sockets) {
			if (socket !== server && socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify({
					type: "player_joined",
					playerId,
				}));
			}
		}

		server.addEventListener("message", (event) => {
			let message: unknown;

			try {
				message = JSON.parse(String(event.data));
			} catch {
				server.send(JSON.stringify({
					type: "error",
					message: "Invalid JSON",
				}));
				return;
			}

			if (
				typeof message !== "object" ||
				message === null ||
				!("type" in message) ||
				message.type !== "operation"
			) {
				server.send(JSON.stringify({
					type: "error",
					message: "Invalid operation",
				}));
				return;
			}

			const operation = message as {
				type: string;
				action?: string;
			};

			if (operation.action === "end_turn") {
				if (playerId !== this.turnPlayer) {
					server.send(JSON.stringify({
						type: "error",
						message: "Not your turn",
					}));
					return;
				}

				this.turnPlayer =
					this.turnPlayer === "player1" ? "player2" : "player1";

				const turnUpdate = {
					type: "turn_changed",
					turnPlayer: this.turnPlayer,
				};

				for (const [socket] of this.sockets) {
					if (socket.readyState === WebSocket.OPEN) {
						socket.send(JSON.stringify(turnUpdate));
					}
				}

				return;
			}

			const operationWithPlayer = {
				...message,
				playerId,
			};

			for (const [socket] of this.sockets) {
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify(operationWithPlayer));
				}
			}
		});

		server.addEventListener("close", () => {
			this.sockets.delete(server);

			for (const [socket] of this.sockets) {
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify({
						type: "player_left",
						playerId,
					}));
				}
			}
		});

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (!url.pathname.startsWith("/room/")) {
			return new Response("Use /room/<room-name>");
		}

		const roomName = url.pathname.slice("/room/".length);

		if (!roomName) {
			return new Response("Room name is required", { status: 400 });
		}

		const id = env.MY_DURABLE_OBJECT.idFromName(roomName);
		const stub = env.MY_DURABLE_OBJECT.get(id);

		return stub.fetch(request);
	},
} satisfies ExportedHandler<Env>;