import ws, {WebSocketServer, WebSocket} from 'ws';
import type http from 'http';
import { Buffer } from 'node:buffer';
import protobuf from 'google-protobuf';
import { MessageType } from "@protobuf-ts/runtime";
//@ts-expect-error:
globalThis.global = globalThis;
import * as protocol from './protocol.ts';
import EventEmitter from 'node:events';

export enum PacketType {
	BadPacketPacket = 1,
	ClientListPacket = 2,
	ClientListRequestPacket = 3,
	DataReceivePacket = 4,
	DataSendPacket = 5,
	IdentityPacket = 6,
	UnknownRecieverPacket = 7
}

type PacketDataMap = {
	1: protocol.BadPacketPacket,
	2: protocol.ClientListPacket,
	3: protocol.ClientListRequestPacket,
	4: protocol.DataReceivePacket,
	5: protocol.DataSendPacket,
	6: protocol.IdentityPacket,
	7: protocol.UnknownRecieverPacket
}

const packet_map: { [K in keyof PacketDataMap]: MessageType<PacketDataMap[K]> } = {
	1: protocol.BadPacketPacket,
	2: protocol.ClientListPacket,
	3: protocol.ClientListRequestPacket,
	4: protocol.DataReceivePacket,
	5: protocol.DataSendPacket,
	6: protocol.IdentityPacket,
	7: protocol.UnknownRecieverPacket
}

export class BlabberPacket<K extends keyof PacketDataMap> {
	kind: K;
	protobuf_message: PacketDataMap[K];
	message_class: MessageType<PacketDataMap[K]>;
	constructor(kind: K, from?: Uint8Array) {
		if (!(kind in packet_map))
			throw 'invalid packet kind';
		this.kind = kind;
		this.message_class = packet_map[kind];
		if (from)
			this.protobuf_message = this.message_class.fromBinary(from)
		else
			this.protobuf_message = this.message_class.create()
	}
	serialize(): Uint8Array {
		const message_class = packet_map[this.kind];
		return new Uint8Array([this.kind, ...message_class.toBinary(this.protobuf_message)])
	}
	static deserialize(packet: Uint8Array): BlabberPacket<keyof PacketDataMap> {
		const kind = packet[0]
		if (kind === undefined || !(kind in packet_map))
			throw 'invalid packet kind'
		return new BlabberPacket(kind as keyof PacketDataMap, packet.slice(1));
	}
}

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

export class BlabberClient {
	static rawData_to_uint8array(data:ws.RawData) {
		//@ts-ignore:
		return new Uint8Array(data)
	}
	socket: WebSocket;
	server: BlabberServer;
	id: number;
	text_encoder = new TextEncoder();
	constructor(server: BlabberServer, socket: WebSocket, _request: http.IncomingMessage, id: number) {
		this.socket = socket;
		this.server = server;
		this.id = id;
		this.socket.on('message', (...args: [ws.RawData, boolean]) => this.on_ws_message(...args));
	}
	on_ws_message(this: BlabberClient, data: ws.RawData, _isBinary: boolean) {
		try {
			console.log(data)
			if (typeof data === 'string') return console.error('is string');
			const uint8_data = (this.constructor as typeof BlabberClient).rawData_to_uint8array(data);
			let packet;
			try {
				packet = BlabberPacket.deserialize(uint8_data);
			} catch (error) {
				console.warn(error);
				return;
			}
			
			const type = packet.message_class.typeName;
			if (type === 'ClientListRequestPacket') {
				const response = new BlabberPacket(PacketType.ClientListPacket)
				response.protobuf_message.clients = this.server.clients.keys().toArray();
				this.socket.send(response.serialize())
				return;
			}
		} catch (error) {
			console.error(error)
		}
	}
	receive(data: Buffer | Uint8Array | string, from: number) {
		let send_data: Uint8Array;
		if (typeof data === 'string')
			send_data = this.text_encoder.encode(data)
		else if (data instanceof Uint8Array)
			send_data = data
		else
			send_data = (this.constructor as typeof BlabberClient).rawData_to_uint8array(data as Buffer);
		
		// this.socket.send(JSON.stringify({
		// 	type: 'DataReceive',
		// 	data: send_data,
		// 	from
		// } as WebsocketProtocol.DataReceivePacket))
	}
}

export declare interface BlabberServer {
    on(event: 'open', listener: () => void): this;
    on(event: 'connection', listener: (client: BlabberClient) => void): this;
    // deno-lint-ignore ban-types
    on(event: string, listener: Function): this;
}

/**
 * A Blabber server
 */
export class BlabberServer extends EventEmitter {
	clients: Map<number, BlabberClient> = new Map();
	ws: WebSocketServer;

	/**
	 * Generates a unique identifier
	 * It is ensured that no client in this instance's BlabberServer.clients has this id
	 * @returns {number} The unique id
	 */
	generate_id(): number {
		let id: number | undefined;
		while (id === undefined || new Set(this.clients.keys()).has(id))
			id = Math.floor(Math.random() * (2 ** 16));
		return id;
	}

	constructor(port: number = 2137) {
		super();
		this.ws = new WebSocketServer({
			port
		});
		this.ws.on('connection', (...args) => this.on_ws_conenction(...args))
		this.ws.on('open', () => {
			this.emit('open')
		})
	}

	/**
	 * Handler for new websocket server connections
	 */
	on_ws_conenction(this: BlabberServer, socket: WebSocket, request: http.IncomingMessage) {
		const client_id = this.generate_id();
		const client = new BlabberClient(this, socket, request, client_id);
		this.clients.set(client_id, client);
		this.emit('connection', client)
	}

	/**
	 * Helper function to send data to a client
	 * This wil be wrapped in a DataReceivePacket message
	 * @returns {null | 'ok'} 'ok' if no errors occured, null if the client was not found
	 */
	send_to(from: number, id: number, data: Buffer | Uint8Array | string): null | 'ok' {
		if (!this.clients.has(id))
			return null;
		this.clients.get(id)!.receive(data, from)
		return 'ok'
	}
}

const server = new BlabberServer();
