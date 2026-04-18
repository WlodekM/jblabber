import crypto from 'node:crypto';
import fs from 'node:fs';
import rl from 'node:readline/promises';
import process from 'node:process';
import { BlabberPacket, PacketDataMap, PacketType as BlabberPacketType, PacketType, PacketNameMap } from './blabber.ts';
import { EventEmitter } from 'node:events';
import * as blabber_protocol from './blabber_protocol.ts';
import * as jabber_protocol from './jabber_protocol.ts';
import { MessageType } from "@protobuf-ts/runtime";
import { Buffer } from 'node:buffer';
const rl_interface = rl.createInterface(
	process.stdin,
	process.stdout,
	(line: string) => [[],line],
	true
);

if (!fs.existsSync('profile'))
	fs.mkdirSync('profile');
if (!fs.existsSync('profile/pub_key') ||
	!fs.existsSync('profile/priv_key')
) {
	console.log('keys not found, creating new key pair')
	// KeyPairExportOptions<"spki", "pkcs8">
	const key_pair = crypto.generateKeyPairSync('ed25519');
	// console.log(key_pair.privateKey, key_pair.publicKey);
	if (fs.existsSync('profile/pub_key'))
		fs.truncateSync('profile/pub_key');
	fs.writeFileSync('profile/pub_key', key_pair.publicKey.export({format: 'pem', type: 'spki'}));
	if (fs.existsSync('profile/priv_key'))
		fs.truncateSync('profile/priv_key');
	fs.writeFileSync('profile/priv_key', key_pair.privateKey.export({format: 'pem', type: 'pkcs8'}));
}
if (!fs.existsSync('profile/username')) {
	console.log('username not found, enter username')
	const username = await rl_interface.question('?');
	if (!username)
		throw 'you have to enter a username, bud'
	if (username.length > 40)
		throw 'look, i know the protocol does not restrict usernames but please dont do that';
	fs.writeFileSync('profile/username', username);
}

const private_key = crypto.createPrivateKey(fs.readFileSync('keys/priv').toString());
const public_key = crypto.createPublicKey(fs.readFileSync('keys/pub').toString());

const te = new TextEncoder()
const PACKET_SIGNATURE = te.encode('JABR');

const username = fs.readFileSync('profile/username').toString()

export declare interface BlabberClient {
	on(event: 'open', listener: () => void): this;
	on(event: 'close', listener: () => void): this;
	on(event: 'error', listener: () => void): this;
	on(event: 'packet', listener: (packet: BlabberPacket<PacketType>) => void): this;
	on<T extends keyof PacketNameMap>(event: T, listener: (packet: BlabberPacket<PacketNameMap[T]>) => void): this;
	on<T extends keyof PacketDataMap>(event: `packet$${T}`, listener: (packet: BlabberPacket<T>) => void): this;
	on(event: `from@${number}`, listener: (data: Uint8Array) => void): this;
	on(event: 'data_receive', listener: (data: Uint8Array, from: number) => void): this;
}

/** blabber - the websocket/p2p part of jblabber */
export class BlabberClient extends EventEmitter {
	socket: WebSocket;
	constructor(socket: WebSocket) {
		super();
		this.socket = socket;
		this.socket.addEventListener('open', () => {
			this.emit('open')
		})
		this.socket.addEventListener('close', () => {
			this.emit('close')
		})
		this.socket.addEventListener('error', () => {
			this.emit('error')
		})
		this.socket.addEventListener('message', async (event) => {
			if (typeof event.data === 'string')
				return;
			
			const bytes = await (event.data as Blob).bytes();
			// if (bytes[0] && bytes.slice(0, 3).every((v, i) => []))
			const packet = BlabberPacket.deserialize(bytes);
			this.emit('packet$'+packet.kind, packet);
			this.emit('packet', packet);
			this.emit(packet.message_class.typeName, packet);
		})
		this.on('DataReceivePacket', (packet: BlabberPacket<PacketType.DataReceivePacket>) => {
			this.emit('data_receive', packet.protobuf_message.data, packet.protobuf_message.from)
			this.emit('from@'+packet.protobuf_message.from, packet.protobuf_message.data)
		})
	}
	wait_for_packet(...types: BlabberPacketType[]): Promise<BlabberPacket<BlabberPacketType>> {
		if (types.length == 0)
			throw new Error('no');
		return new Promise((resolve) => {
			if (types.length == 1)
				return this.once(`packet$${types[0]}`, resolve);
			const listeners: string[] = [];
			const yeag = (packet: BlabberPacket<BlabberPacketType>) => {
				for (const listener of listeners) {
					this.off(listener, yeag)
				}
				resolve(packet);
			}
			for (const type of types) {
				const listener = `packet$${type}`;
				listeners.push(listener);
				this.once(listener, yeag);
			}
		})
	}
	send_packet<T extends BlabberPacketType>(kind: BlabberPacketType, data: PacketDataMap[T]) {
		const packet = new BlabberPacket(kind);
		packet.protobuf_message = data;
		this.socket.send(packet.serialize())
	}
	send_to(data: Uint8Array, to: number) {
		this.send_packet(BlabberPacketType.DataSendPacket, {
			data,
			to
		} as PacketDataMap[BlabberPacketType.DataSendPacket])
	}
	announce(data: Uint8Array) {
		this.send_packet(BlabberPacketType.DataAnnouncePacket, {
			data
		} as PacketDataMap[BlabberPacketType.DataAnnouncePacket])
	}
}

export enum JabberPacketType {
	JabberHello = 1,
	JabberHelloResponse = 2,
	JabberIdentify = 3,
	JabberMessagePacket = 4,
}

export type JabberPacketDataMap = {
	1: jabber_protocol.JabberHello,
	2: jabber_protocol.JabberHelloResponse,
	3: jabber_protocol.JabberIdentify,
	4: jabber_protocol.JabberMessagePacket,
}

const packet_map: { [K in keyof JabberPacketDataMap]: MessageType<JabberPacketDataMap[K]> } = {
	1: jabber_protocol.JabberHello,
	2: jabber_protocol.JabberHelloResponse,
	3: jabber_protocol.JabberIdentify,
	4: jabber_protocol.JabberMessagePacket,
}

export class JabberPacket<K extends keyof JabberPacketDataMap> {
	kind: K;
	protobuf_message: JabberPacketDataMap[K];
	message_class: MessageType<JabberPacketDataMap[K]>;
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
		return new Uint8Array([...PACKET_SIGNATURE, this.kind, ...message_class.toBinary(this.protobuf_message)])
	}
	static deserialize(packet: Uint8Array): JabberPacket<keyof JabberPacketDataMap> | undefined {
		if (!packet.slice(0, 3).every((a, i) => PACKET_SIGNATURE[i] === a))
			return;
		const kind = packet[4]
		if (kind === undefined || !(kind in packet_map))
			return;
		return new JabberPacket(kind as keyof JabberPacketDataMap, packet.slice(4));
	}
}

interface Contact {
	username: string;
	key_hash: Uint8Array;
	key?: crypto.KeyObject;
	client_id: number;
	handshake_complete: boolean;
}

function compareuint8arrays(arr1: Uint8Array, arr2: Uint8Array) {
	if (arr1.length !== arr2.length)
		return false;
	return arr1.every((a, i) => arr2[i] === a);
}

/** jabber - the e2ee/chat protocol part of jblabber */
class Jabber extends EventEmitter {
	static buffer_to_uint8array(data: Buffer) {
		//@ts-ignore:
		return new Uint8Array(data)
	}
	blabber: BlabberClient;
	// handle_poke() {}
	username: string;
	public_key: crypto.KeyObject;
	private_key: crypto.KeyObject;
	contact_list: Map<string, Contact> = new Map();
	username_valid(username: string): boolean {
		if (username.length > 32 || username.length == 0)
			return false;
		if (username.match(/[^a-zA-Z0-9`~!#%^&*()-_.]/))
			return false;
		return true;
	}
	constructor(url: string = 'ws://localhost:2137', username: string, public_key: crypto.KeyObject, private_key: crypto.KeyObject) {
		super()
		this.username = username;
		this.public_key = public_key;
		this.private_key = private_key;
		this.blabber = new BlabberClient(new WebSocket(url));
		this.blabber.on('open', () => {
			this.blabber.announce(this.get_identify_packet().serialize())
		})
		this.blabber.on('data_receive', (data, from) => {
			const packet = JabberPacket.deserialize(data);
			if (!packet)
				return;
			if (packet.kind == JabberPacketType.JabberIdentify) {
				const identify_packet = packet as JabberPacket<JabberPacketType.JabberIdentify>;
				if (!this.username_valid(identify_packet.protobuf_message.username))
					return;
				const identifier = `${identify_packet.protobuf_message.username}$${[...identify_packet.protobuf_message.hash].map(i => i.toString(16)).join('')}`
				if (this.contact_list.has(identifier))
					return;
				this.contact_list.set(identifier, {
					client_id: from,
					handshake_complete: false,
					key_hash: identify_packet.protobuf_message.hash,
					username: identify_packet.protobuf_message.username,
				})
			} else if (packet.kind == JabberPacketType.JabberHello) {
				const hello_packet = packet as JabberPacket<JabberPacketType.JabberHello>;
				const identity_known = this.contact_list.values().find(contact => contact.client_id === from);
				let contact: Contact;
				if (!identity_known) {
					if (!hello_packet.protobuf_message.me)
						return;
					if (!this.username_valid(hello_packet.protobuf_message.me.username))
						return;
					const identify_packet = hello_packet.protobuf_message.me;
					const identifier = `${identify_packet.username}$${[...identify_packet.hash].map(i => i.toString(16)).join('')}`
					if (this.contact_list.has(identifier)) {
						if (this.contact_list.get(identifier)!.client_id !== from)
							return;
						throw new Error('invalid state')
					}
					contact = {
						client_id: from,
						handshake_complete: false,
						key_hash: identify_packet.hash,
						username: identify_packet.username,
					};
					this.contact_list.set(identifier, contact)
				} else {
					contact = identity_known;
					if (hello_packet.protobuf_message.me) {
						if (compareuint8arrays(contact.key_hash, hello_packet.protobuf_message.me.hash))
							return;
						if (contact.username !== hello_packet.protobuf_message.me.username)
							return;
						const hash = crypto.hash('sha512', hello_packet.protobuf_message.publicKey, 'buffer');
						if (compareuint8arrays(contact.key_hash, Jabber.buffer_to_uint8array(hash)))
							return;
					}
				}
				if (contact.handshake_complete)
					return;
				const public_key = crypto.createPublicKey({
					key: Buffer.from(hello_packet.protobuf_message.publicKey),
					format: 'der',
				});
				console.log(public_key)
				// contact.key = 
			}
		})
	}
	get_identify_packet(): JabberPacket<JabberPacketType.JabberIdentify> {
		const identify_packet = new JabberPacket(JabberPacketType.JabberIdentify);
		identify_packet.protobuf_message.username = this.username;
		const hash = crypto.hash('sha512', this.public_key.export({format: 'der', type: 'spki'}), 'buffer')
		identify_packet.protobuf_message.hash = Jabber.buffer_to_uint8array(hash);
		return identify_packet;
	}
	initiate_handshake(contact: Contact) {
		if (contact.handshake_complete)
			return;
		const hello_packet = new JabberPacket(JabberPacketType.JabberHello);
		hello_packet.protobuf_message.me = this.get_identify_packet().protobuf_message;
		hello_packet.protobuf_message.publicKey = Jabber.buffer_to_uint8array(this.public_key.export({format: 'der', type: 'spki'}));
		this.blabber.send_to(hello_packet.serialize(), contact.client_id);
	}
}

// const ws = new WebSocket('ws://localhost:2137')
// ws.addEventListener('message', async (event) => {
// 	if (typeof event.data === 'string')
// 		console.log(String(event.data))
// 	else {
// 		const bytes = await (event.data as Blob).bytes();
// 		const packet = BlabberPacket.deserialize(bytes);
// 		console.log(packet.kind, packet.message_class.typeName, packet.protobuf_message)
// 	}
// })
// ws.addEventListener('open', (event) => {
// 	console.log('open')
// })
// ws.addEventListener('close', (event) => {
// 	console.log(`close ${event.code}`)
// })
// ws.addEventListener('error', (event) => {
// 	console.log('error')
// })

// rl_interface.on('SIGINT', () => {
// 	process.exit(0)
// });
// rl_interface.on('close', () => process.exit(0));
// while (true) {
// 	const command = await rl_interface.question(': ')
// 	console.log(JSON.stringify(command))
// 	if (command == null || command == '/exit') {
// 		ws.close();
// 		break
// 	} else if (command == '/list') {
// 		const uh = blabber_protocol.ClientListRequestPacket.create();
// 		const fuckme = blabber_protocol.ClientListRequestPacket.toBinary(uh)
// 		ws.send(new Uint8Array([3, ...fuckme]))
// 	}
// }
