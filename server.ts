import ws, {WebSocketServer, WebSocket} from 'ws';
import type http from 'http';
import { Buffer } from 'node:buffer';

// deno-lint-ignore no-namespace
export namespace WebsocketProtocol {
	export type PacketType =
		'DataReceive' |
		'ClientList' |
		'DataSend' |
		'ClientListRequest' |
		'BadPacket' |
		'UnknownReciever'
	export interface Packet {
		type: PacketType
	}
	// Server -> Client
	export interface DataReceivePacket extends Packet {
		type: 'DataReceive'
		data: string
		from: number
	}
	export interface ClientListPacket extends Packet {
		type: 'ClientList'
		clients: number[]
	}
	// export interface PokeResponsePacket extends Packet {
	// 	type: 'ClientList'
	// 	from: number
	// }
	// Client -> Server
	export interface DataSendPacket extends Packet {
		type: 'DataSend'
		data: string
		to: number
	}
	export interface ClientListRequestPacket extends Packet {
		type: 'ClientListRequest'
	}
	export interface BadPacketPacket extends Packet {
		type: 'BadPacket'
	}
	export interface UnknownRecieverPacket extends Packet {
		type: 'UnknownReciever'
	}
	// export interface PokePacket extends Packet {
	// 	type: 'PokePacket'
	// 	to: number
	// }
}

class ServerClient {
	socket: WebSocket;
	server: Server;
	id: number;
	text_decoder = new TextDecoder();
	constructor(server: Server, socket: WebSocket, request: http.IncomingMessage, id: number) {
		this.socket = socket;
		this.server = server;
		this.id = id;
		this.socket.on('message', (...args: [ws.RawData, boolean]) => this.on_ws_message(...args));
	}
	on_ws_message(this: ServerClient, data: ws.RawData, isBinary: boolean) {
		// console.log(data)
		// if (typeof data !== 'string') return;
		try {
			const json: WebsocketProtocol.Packet = JSON.parse(data.toString());
			console.log(json)
			if (!json.type)
				return;
			if (json.type == 'DataSend') {
				const data_send_packet = json as WebsocketProtocol.DataSendPacket
				if (typeof data_send_packet.to !== 'number' || isNaN(data_send_packet.to))
					this.socket.send(JSON.stringify({ type: 'BadPacket' } as WebsocketProtocol.BadPacketPacket));
				this.server.send_to(this.id, data_send_packet.to, data_send_packet.data)
			} else if (json.type == 'ClientListRequest') {
					this.socket.send(JSON.stringify({
						type: 'ClientList',
						clients: this.server.clients.keys().toArray()
					} as WebsocketProtocol.ClientListPacket));
			}
		} catch (_) {
			/**/
		}
	}
	receive(data: Buffer | Uint8Array | string, from: number) {
		let send_data: string;
		if (typeof data === 'string')
			send_data = data
		else if (data instanceof Uint8Array)
			send_data = this.text_decoder.decode(data)
		else
			send_data = (data as Buffer).toString();
		this.socket.send(JSON.stringify({
			type: 'DataReceive',
			data: send_data,
			from
		} as WebsocketProtocol.DataReceivePacket))
	}
}

class Server {
	clients: Map<number, ServerClient> = new Map();
	ws: WebSocketServer;

	get_id(): number {
		let id: number | undefined;
		while (id === undefined || new Set(this.clients.keys()).has(id))
			id = Math.floor(Math.random() * (2 ** 16));
		return id;
	}

	constructor(port: number = 2137) {
		this.ws = new WebSocketServer({
			port
		});
		this.ws.on('connection', (...args) => this.on_ws_conenction(...args))
	}

	on_ws_conenction(this: Server, socket: WebSocket, request: http.IncomingMessage) {
		const client_id = this.get_id();
		const client = new ServerClient(this, socket, request, client_id);
		this.clients.set(client_id, client);
	}

	send_to(from: number, id: number, data: Buffer | Uint8Array | string): null | 'ok' {
		if (!this.clients.has(id))
			return null;
		this.clients.get(id)!.receive(data, from)
		return 'ok'
	}
}

const server = new Server();
