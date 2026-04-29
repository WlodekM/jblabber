import type { WebSocketServer, WebSocket } from 'ws';
import type ws from 'ws';
import type http from 'http';
import { Buffer } from 'node:buffer';
// import protobuf from 'google-protobuf';
import type { MessageType } from "@protobuf-ts/runtime";
//@ts-ignore:
globalThis.global = globalThis;
import * as protocol from './blabber_protocol.ts';
import EventEmitter from 'node:events';
import Logger from "./logger.ts";

type interval_t = ReturnType<typeof setInterval>

export enum PacketType {
	BadPacketPacket = 1,
	ClientListPacket = 2,
	ClientListRequestPacket = 3,
	DataReceivePacket = 4,
	DataSendPacket = 5,
	IdentityPacket = 6,
	UnknownRecieverPacket = 7,
	DataAnnouncePacket = 8,
	ClientConnectPacket = 9,
	ClientDisconnectPacket = 10,
}

export type PacketNameMap = {
	BadPacketPacket: 1,
	ClientListPacket: 2,
	ClientListRequestPacket: 3,
	DataReceivePacket: 4,
	DataSendPacket: 5,
	IdentityPacket: 6,
	UnknownRecieverPacket: 7,
	DataAnnouncePacket: 8,
	ClientConnectPacket: 9,
	ClientDisconnectPacket: 10,
}
export type PacketDataMap = {
	1: protocol.BadPacketPacket,
	2: protocol.ClientListPacket,
	3: protocol.ClientListRequestPacket,
	4: protocol.DataReceivePacket,
	5: protocol.DataSendPacket,
	6: protocol.IdentityPacket,
	7: protocol.UnknownRecieverPacket,
	8: protocol.DataAnnouncePacket,
	9: protocol.ClientConnectPacket,
	10: protocol.ClientDisconnectPacket
}

const packet_map: { [K in keyof PacketDataMap]: MessageType<PacketDataMap[K]> } = {
	1: protocol.BadPacketPacket,
	2: protocol.ClientListPacket,
	3: protocol.ClientListRequestPacket,
	4: protocol.DataReceivePacket,
	5: protocol.DataSendPacket,
	6: protocol.IdentityPacket,
	7: protocol.UnknownRecieverPacket,
	8: protocol.DataAnnouncePacket,
	9: protocol.ClientConnectPacket,
	10: protocol.ClientDisconnectPacket,
}

export class BlabberPacket<K extends keyof PacketDataMap> {
	kind: K;
	protobuf_message: PacketDataMap[K];
	message_class: MessageType<PacketDataMap[K]>;
	constructor(kind: K, from?: Uint8Array) {
		if (!(kind in packet_map))
			throw new Error('invalid packet kind');
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
			throw new Error('invalid packet kind');
		return new BlabberPacket(kind as keyof PacketDataMap, packet.slice(1));
	}
}

export class BlabberServerClient {
	static rawData_to_uint8array(data: ws.RawData) {
		//@ts-ignore:
		return new Uint8Array(data)
	}
	socket: WebSocket;
	server: BlabberServer;
	id: number;
	text_encoder = new TextEncoder();
	ping_interval: interval_t;
	constructor(server: BlabberServer, socket: WebSocket, _request: http.IncomingMessage, id: number) {
		this.socket = socket;
		this.server = server;
		this.id = id;
		this.socket.on('message', (...args: [ws.RawData, boolean]) => this.on_ws_message(...args));
		this.socket.on('close', () => this.self_destruct())
		this.socket.on('error', (e) => {
			this.server.logger.error('client error', e)
			this.self_destruct()
		})
		this.ping_interval = setInterval(() => {
			this.socket.ping()
		}, 2000);
	}
	self_destruct(this: BlabberServerClient) {
		this.on_ws_disconnect()
		this.server.logger.debug('client', this.id, 'disconnected, self-destructing client class');
		clearInterval(this.ping_interval)
		this.server.clients.delete(this.id);
		this.socket.removeAllListeners();
		this.socket.terminate();
	}
	on_ws_disconnect(this: BlabberServerClient) {
		const disconnect_packet = new BlabberPacket(PacketType.ClientDisconnectPacket)
		disconnect_packet.protobuf_message.client = this.id;
		const serialized_disconnect_packet = disconnect_packet.serialize();
		for (const [id, client] of this.server.clients.entries()) {
			if (id === this.id) continue;
			client.receive_packet(serialized_disconnect_packet)
		}
	}
	on_ws_message(this: BlabberServerClient, data: ws.RawData, _isBinary: boolean) {
		try {
			this.server.logger.debug(data)
			if (typeof data === 'string')
				return this.server.logger.error('data is string');
			const uint8_data = (this.constructor as typeof BlabberServerClient).rawData_to_uint8array(data);
			let packet;
			try {
				packet = BlabberPacket.deserialize(uint8_data);
			} catch (error) {
				this.server.logger.warn('deserialization error', error);
				return;
			}

			const type = packet.message_class.typeName;
			if (type === 'ClientListRequestPacket') {
				const response = new BlabberPacket(PacketType.ClientListPacket)
				response.protobuf_message.clients = this.server.clients.keys().toArray();
				this.socket.send(response.serialize())
				return;
			} else if (type === 'DataSendPacket') {
				const ds_packet = packet as BlabberPacket<PacketType.DataSendPacket>;
				this.server.send_to(this.id, ds_packet.protobuf_message.to, ds_packet.protobuf_message.data)
				return;
			} else if (type === 'DataAnnouncePacket') {
				const da_packet = packet as BlabberPacket<PacketType.DataAnnouncePacket>;
				this.server.announce(this.id, da_packet.protobuf_message.data)
				return;
			}
		} catch (error) {
			this.server.logger.error('on_ws_message error', error)
		}
	}
	receive(data: Buffer | Uint8Array | string, from: number) {
		let send_data: Uint8Array;
		if (typeof data === 'string')
			send_data = this.text_encoder.encode(data)
		else if (data instanceof Uint8Array)
			send_data = data
		else
			send_data = (this.constructor as typeof BlabberServerClient).rawData_to_uint8array(data as Buffer);

		const packet = new BlabberPacket(PacketType.DataReceivePacket);
		packet.protobuf_message.from = from;
		packet.protobuf_message.data = send_data;
		this.socket.send(packet.serialize())
	}
	receive_packet(data: Uint8Array) {
		this.socket.send(data)
	}
}

export declare interface BlabberServer {
	on(event: 'open', listener: (port: number) => void): this;
	on(event: 'connection', listener: (client: BlabberServerClient) => void): this;
	// deno-lint-ignore ban-types
	on(event: string, listener: Function): this;
}

/**
 * A Blabber server
 */
export class BlabberServer extends EventEmitter {
	clients: Map<number, BlabberServerClient> = new Map();
	ws: WebSocketServer;
	public logger: Logger = new Logger();

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

	constructor(ws: WebSocketServer) {
		super();
		this.ws = ws;
		this.ws.on('connection', (...args) => this.on_ws_conenction(...args))
		this.ws.on('listening', () => {
			setTimeout(() => this.emit('open', ws.options.port))
		})
	}

	/**
	 * Handler for new websocket server connections
	 */
	on_ws_conenction(this: BlabberServer, socket: WebSocket, request: http.IncomingMessage) {
		const client_id = this.generate_id();
		const client = new BlabberServerClient(this, socket, request, client_id);
		this.clients.set(client_id, client);
		this.emit('connection', client);
		const connect_packet = new BlabberPacket(PacketType.ClientConnectPacket)
		connect_packet.protobuf_message.client = client_id;
		const serialized_connect_packet = connect_packet.serialize();
		for (const [id, client] of this.clients.entries()) {
			if (id === client_id) continue;
			client.receive_packet(serialized_connect_packet)
		}
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
	/**
	 * Helper function to send data to all clients
	 * This will be wrapped in a DataReceivePacket message
	 */
	announce(from: number, data: Buffer | Uint8Array | string): void {
		for (const id of this.clients.keys()) {
			if (id === from) continue;
			this.send_to(from, id, data)
		}
	}
}
