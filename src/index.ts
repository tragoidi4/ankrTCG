import { DurableObject } from "cloudflare:workers";

export class MyDurableObject extends DurableObject<Env> {
	private sockets = new Map<WebSocket, string>();
	private sessionSeats = new Map<string, string>();
	private playerNames = new Map<string, string>();
	private publicStates = new Map<string, unknown>();
	private reconnectingPlayers = new Set<string>();
	private turnPlayer = "player1";

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("WebSocket room", { status: 200 });
		}

		const savedRoom = await this.ctx.storage.get<{
			publicStates?: Record<string, unknown>;
			playerNames?: Record<string, string>;
			sessionSeats?: Record<string, string>;
			turnPlayer?: string;
		}>("roomState");
		if (savedRoom) {
			for (const [id, state] of Object.entries(savedRoom.publicStates || {})) this.publicStates.set(id, state);
			for (const [id, name] of Object.entries(savedRoom.playerNames || {})) this.playerNames.set(id, name);
			for (const [sessionId, id] of Object.entries(savedRoom.sessionSeats || {})) this.sessionSeats.set(sessionId, id);
			if (savedRoom.turnPlayer === "player1" || savedRoom.turnPlayer === "player2") this.turnPlayer = savedRoom.turnPlayer;
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		const session = new URL(request.url).searchParams.get("session");
		if (!session) return new Response("Session is required", { status: 400 });

		for (const [socket] of this.sockets) {
			if (socket.readyState !== WebSocket.OPEN) this.sockets.delete(socket);
		}

		const savedPlayerId = this.sessionSeats.get(session);
		if (savedPlayerId) {
			for (const [oldSocket, oldPlayerId] of this.sockets) {
				if (oldPlayerId === savedPlayerId) {
					this.reconnectingPlayers.add(oldPlayerId);
					this.sockets.delete(oldSocket);
					if (oldSocket.readyState === WebSocket.OPEN) oldSocket.close(1000, "Reconnected");
				}
			}
		}

		if (this.sockets.size >= 2) {
			server.accept();
			server.send(JSON.stringify({type:"error",message:"Room is full"}));
			server.close(1008, "Room is full");
			return new Response(null, {status:101, webSocket:client});
		}

		server.accept();

		let playerId: string;
		if (savedPlayerId) {
			playerId = savedPlayerId;
		} else {
			const usedPlayerIds = new Set(this.sockets.values());
			playerId = usedPlayerIds.has("player1") ? "player2" : "player1";
			this.sessionSeats.set(session, playerId);
		}

		if (!this.playerNames.has(playerId)) {
			this.playerNames.set(playerId, playerId === "player1" ? "プレイヤー1" : "プレイヤー2");
		}

		this.sockets.set(server, playerId);

		const players = {
			player1: this.playerNames.get("player1") || "プレイヤー1",
			player2: this.playerNames.get("player2") || "プレイヤー2",
		};
		const roomStatus = () => JSON.stringify({type:"room_status",playerCount:this.sockets.size});

		server.send(JSON.stringify({type:"joined",playerId,turnPlayer:this.turnPlayer,players}));
		server.send(roomStatus());
		for (const [otherPlayerId, publicState] of this.publicStates) {
			if (otherPlayerId !== playerId) {
				server.send(JSON.stringify({type:"public_state",playerId:otherPlayerId,state:publicState}));
			}
		}

		for (const [socket] of this.sockets) {
			if (socket !== server && socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify({type:"player_joined",playerId,players}));
			}
		}
		for (const [socket] of this.sockets) {
			if (socket.readyState === WebSocket.OPEN) socket.send(roomStatus());
		}

		server.addEventListener("message", async (event) => {
			let message: unknown;
			try {
				message = JSON.parse(String(event.data));
			} catch {
				server.send(JSON.stringify({type:"error",message:"Invalid JSON"}));
				return;
			}

			if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "operation") {
				server.send(JSON.stringify({type:"error",message:"Invalid operation"}));
				return;
			}

			const operation = message as {type:string;action?:string;name?:string};

			if (operation.action === "sync_public_state") {
				if (!("state" in message) || typeof message.state !== "object" || message.state === null) {
					server.send(JSON.stringify({type:"error",message:"Invalid public state"}));
					return;
				}
				this.publicStates.set(playerId, message.state);
				await this.ctx.storage.put("roomState", {
					publicStates: Object.fromEntries(this.publicStates),
					playerNames: Object.fromEntries(this.playerNames),
					sessionSeats: Object.fromEntries(this.sessionSeats),
					turnPlayer: this.turnPlayer,
				});
				const update = JSON.stringify({type:"public_state",playerId,state:message.state});
				for (const [socket] of this.sockets) {
					if (socket.readyState === WebSocket.OPEN) socket.send(update);
				}
				return;
			}

			if (operation.action === "log") {
				const text = typeof (message as {text?: unknown}).text === "string" ? (message as {text:string}).text.slice(0,200) : "";
				if (!text) {
					server.send(JSON.stringify({type:"error",message:"Log text is required"}));
					return;
				}
				const logUpdate = JSON.stringify({type:"log",playerId,text});
				for (const [socket] of this.sockets) {
					if (socket !== server && socket.readyState === WebSocket.OPEN) socket.send(logUpdate);
				}
				return;
			}

			if (operation.action === "set_name") {
				const name = typeof operation.name === "string" ? operation.name.trim().slice(0,16) : "";
				if (!name) {
					server.send(JSON.stringify({type:"error",message:"Name is required"}));
					return;
				}
				this.playerNames.set(playerId, name);
				const nameUpdate = {
					type:"player_names",
					players:{
						player1:this.playerNames.get("player1") || "プレイヤー1",
						player2:this.playerNames.get("player2") || "プレイヤー2",
					},
				};
				for (const [socket] of this.sockets) {
					if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(nameUpdate));
				}
				return;
			}

			if (operation.action === "set_first_player") {
				if (this.sockets.size < 2) {
					server.send(JSON.stringify({type:"error",message:"Opponent is not connected"}));
					return;
				}
				if (playerId !== "player1" && playerId !== "player2") {
					server.send(JSON.stringify({type:"error",message:"Invalid player"}));
					return;
				}
				const target = (message as {target?: unknown}).target;
				if (target !== "player1" && target !== "player2") {
					server.send(JSON.stringify({type:"error",message:"Invalid first player"}));
					return;
				}
				const previousTurnPlayer = this.turnPlayer;
				this.turnPlayer = target;
				const firstPlayerUpdate = {type:"first_player_set",turnPlayer:this.turnPlayer};
				for (const [socket] of this.sockets) {
					if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(firstPlayerUpdate));
				}
				return;
			}

			if (operation.action === "end_turn") {
				if (playerId !== this.turnPlayer) {
					server.send(JSON.stringify({type:"error",message:"Not your turn"}));
					return;
				}
				const previousTurnPlayer = this.turnPlayer;
				this.turnPlayer = this.turnPlayer === "player1" ? "player2" : "player1";
				const turnUpdate = {type:"turn_changed",previousTurnPlayer,turnPlayer:this.turnPlayer};
				for (const [socket] of this.sockets) {
					if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(turnUpdate));
				}
				return;
			}

			const operationWithPlayer = {...message,playerId};
			for (const [socket] of this.sockets) {
				if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(operationWithPlayer));
			}
		});

		server.addEventListener("close", () => {
			this.sockets.delete(server);
			if (this.reconnectingPlayers.has(playerId)) {
				this.reconnectingPlayers.delete(playerId);
				return;
			}
			for (const [socket] of this.sockets) {
				if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type:"player_left",playerId}));
			}
			const status = JSON.stringify({type:"room_status",playerCount:this.sockets.size});
			for (const [socket] of this.sockets) {
				if (socket.readyState === WebSocket.OPEN) socket.send(status);
			}
		});

		return new Response(null, {status:101,webSocket:client});
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/room/")) return new Response("Use /room/<room-name>");
		const roomName = url.pathname.slice("/room/".length);
		if (!roomName) return new Response("Room name is required", {status:400});
		const id = env.MY_DURABLE_OBJECT.idFromName(roomName);
		const stub = env.MY_DURABLE_OBJECT.get(id);
		return stub.fetch(request);
	},
} satisfies ExportedHandler<Env>;
